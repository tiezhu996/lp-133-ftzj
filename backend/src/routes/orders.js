const { Router } = require('express');
const pool = require('../../db');
const messages = require('../constants/messages');
const { authenticateToken } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');

const router = Router();

router.get('/', authenticateToken, asyncHandler(async (req, res) => {
  const { status } = req.query;
  let sql = `SELECT o.*, n.title, n.type, n.address,
    u1.name as user_name, u2.name as volunteer_name,
    u3.name as cancelled_by_name,
    EXISTS(SELECT 1 FROM reviews r WHERE r.order_id = o.id) as has_review
    FROM orders o
    LEFT JOIN needs n ON o.need_id = n.id
    LEFT JOIN users u1 ON o.user_id = u1.id
    LEFT JOIN users u2 ON o.volunteer_id = u2.id
    LEFT JOIN users u3 ON o.cancelled_by = u3.id
    WHERE o.user_id = ? OR o.volunteer_id = ?`;
  const params = [req.user.id, req.user.id];

  if (status) {
    sql += ' AND o.status = ?';
    params.push(status);
  }

  sql += ' ORDER BY o.created_at DESC';

  const [rows] = await pool.query(sql, params);
  res.json({ orders: rows });
}));

// 志愿者开始服务：开始后（start_time 有值）订单即不可取消
router.post('/:id/start', authenticateToken, asyncHandler(async (req, res) => {
  const orderId = req.params.id;
  const [orders] = await pool.query('SELECT * FROM orders WHERE id = ?', [orderId]);

  if (orders.length === 0) {
    return res.status(404).json({ message: messages.orders.notFound });
  }

  const order = orders[0];

  if (order.volunteer_id !== req.user.id) {
    return res.status(403).json({ message: messages.orders.startForbidden });
  }

  const [result] = await pool.query(
    "UPDATE orders SET start_time = NOW() WHERE id = ? AND status = 'in_progress' AND start_time IS NULL",
    [orderId],
  );

  if (result.affectedRows === 0) {
    return res.status(400).json({ message: messages.orders.alreadyStarted });
  }

  res.json({ message: messages.orders.started });
}));

// 取消订单（志愿者预约前撤回 / 居民取消）：同步释放需求、关闭进行中订单、记录原因
router.post('/:id/cancel', authenticateToken, asyncHandler(async (req, res) => {
  const orderId = req.params.id;
  const { reason } = req.body;

  if (!reason || !String(reason).trim()) {
    return res.status(400).json({ message: messages.orders.reasonRequired });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [orders] = await conn.query(
      'SELECT * FROM orders WHERE id = ? FOR UPDATE',
      [orderId],
    );

    if (orders.length === 0) {
      await conn.rollback();
      return res.status(404).json({ message: messages.orders.notFound });
    }

    const order = orders[0];

    if (order.user_id !== req.user.id && order.volunteer_id !== req.user.id) {
      await conn.rollback();
      return res.status(403).json({ message: messages.orders.forbidden });
    }

    // 已开始（start_time 有值）、已完成、已评价的订单禁止取消
    const [reviews] = await conn.query(
      'SELECT 1 FROM reviews WHERE order_id = ? LIMIT 1',
      [orderId],
    );

    if (order.status !== 'in_progress' || order.start_time !== null || reviews.length > 0) {
      await conn.rollback();
      return res.status(400).json({ message: messages.orders.cannotCancel });
    }

    // 关闭进行中订单并记录取消人、原因、时间；条件更新保证并发取消只有一次生效
    const [orderResult] = await conn.query(
      `UPDATE orders
       SET status = 'cancelled',
           cancelled_by = ?,
           cancel_reason = ?,
           cancelled_at = NOW()
       WHERE id = ? AND status = 'in_progress' AND start_time IS NULL`,
      [req.user.id, String(reason).trim(), orderId],
    );

    if (orderResult.affectedRows === 0) {
      await conn.rollback();
      return res.status(400).json({ message: messages.orders.cannotCancel });
    }

    // 释放需求：回到待接单状态并清空接单志愿者，其他志愿者可重新接单
    const [needResult] = await conn.query(
      "UPDATE needs SET status = 'pending', volunteer_id = NULL WHERE id = ? AND status = 'accepted'",
      [order.need_id],
    );

    if (needResult.affectedRows === 0) {
      // 需求状态与订单不一致时整体失败，绝不只改一边的状态
      await conn.rollback();
      return res.status(400).json({ message: messages.orders.cannotCancel });
    }

    await conn.commit();
    res.json({
      message: messages.orders.cancelled,
      needId: order.need_id,
    });
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}));

router.put('/:id/complete', authenticateToken, asyncHandler(async (req, res) => {
  const { service_hours } = req.body;
  const orderId = req.params.id;
  const [orders] = await pool.query('SELECT * FROM orders WHERE id = ?', [orderId]);

  if (orders.length === 0) {
    return res.status(404).json({ message: messages.orders.notFound });
  }

  if (orders[0].user_id !== req.user.id && orders[0].volunteer_id !== req.user.id) {
    return res.status(403).json({ message: messages.orders.forbidden });
  }

  // 已取消/已完成的订单不能再完成，条件更新保证与取消并发时失败方不改状态
  const [result] = await pool.query(
    "UPDATE orders SET status = 'completed', service_hours = ? WHERE id = ? AND status = 'in_progress'",
    [service_hours || 1, orderId],
  );

  if (result.affectedRows === 0) {
    return res.status(400).json({ message: messages.orders.completeNotAllowed });
  }

  await pool.query(
    "UPDATE needs SET status = 'completed' WHERE id = ? AND status = 'accepted'",
    [orders[0].need_id],
  );

  const hours = service_hours || 1;
  await pool.query(
    'UPDATE users SET service_hours = service_hours + ?, points = points + ? WHERE id = ?',
    [hours, hours * 10, orders[0].volunteer_id],
  );

  res.json({ message: messages.orders.completed });
}));

router.post('/:id/review', authenticateToken, asyncHandler(async (req, res) => {
  const { rating, comment } = req.body;
  const orderId = req.params.id;

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [orders] = await conn.query(
      'SELECT * FROM orders WHERE id = ? FOR UPDATE',
      [orderId],
    );

    if (orders.length === 0) {
      await conn.rollback();
      return res.status(404).json({ message: messages.orders.notFound });
    }

    const order = orders[0];

    if (order.user_id !== req.user.id && order.volunteer_id !== req.user.id) {
      await conn.rollback();
      return res.status(403).json({ message: messages.orders.forbidden });
    }

    // 只有已完成订单可以评价；行锁 + 插入前去重，防止并发重复评价
    const [existing] = await conn.query(
      'SELECT id FROM reviews WHERE order_id = ? LIMIT 1',
      [orderId],
    );

    if (order.status !== 'completed') {
      await conn.rollback();
      return res.status(400).json({ message: messages.orders.reviewNotAllowed });
    }

    if (existing.length > 0) {
      await conn.rollback();
      return res.status(400).json({ message: messages.orders.alreadyReviewed });
    }

    const targetId = order.user_id === req.user.id
      ? order.volunteer_id
      : order.user_id;

    await conn.query(
      'INSERT INTO reviews (order_id, reviewer_id, target_id, rating, comment) VALUES (?, ?, ?, ?, ?)',
      [orderId, req.user.id, targetId, rating, comment],
    );

    await conn.commit();
    res.json({ message: messages.orders.reviewed });
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}));

module.exports = router;
