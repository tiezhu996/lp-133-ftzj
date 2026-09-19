const { Router } = require('express');
const pool = require('../../db');
const messages = require('../constants/messages');
const { authenticateToken } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');

const router = Router();

// 判断服务是否已经开始：已记录开始时间，或预约时间已过
const isServiceStarted = (order, need) => {
  if (order.start_time) {
    return true;
  }
  return Boolean(need.expected_time) && new Date(need.expected_time).getTime() <= Date.now();
};

router.get('/', authenticateToken, asyncHandler(async (req, res) => {
  const { status } = req.query;
  let sql = `SELECT o.*, n.title, n.type, n.address, n.expected_time,
    u1.name as user_name, u2.name as volunteer_name,
    u3.name as cancelled_by_name
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

router.put('/:id/complete', authenticateToken, asyncHandler(async (req, res) => {
  const { service_hours } = req.body;
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

    if (orders[0].user_id !== req.user.id && orders[0].volunteer_id !== req.user.id) {
      await conn.rollback();
      return res.status(403).json({ message: messages.orders.forbidden });
    }

    // 只有进行中的订单可以完成，已取消等状态禁止改状态
    if (orders[0].status !== 'in_progress') {
      await conn.rollback();
      return res.status(400).json({ message: messages.orders.cannotCompleteStatus });
    }

    const hours = service_hours || 1;

    const [updateResult] = await conn.query(
      "UPDATE orders SET status = 'completed', service_hours = ?, end_time = NOW() WHERE id = ? AND status = 'in_progress'",
      [hours, orderId],
    );

    if (updateResult.affectedRows !== 1) {
      await conn.rollback();
      return res.status(400).json({ message: messages.orders.cannotCompleteStatus });
    }

    await conn.query(
      "UPDATE needs SET status = 'completed' WHERE id = ?",
      [orders[0].need_id],
    );

    await conn.query(
      'UPDATE users SET service_hours = service_hours + ?, points = points + ? WHERE id = ?',
      [hours, hours * 10, orders[0].volunteer_id],
    );

    await conn.commit();
    res.json({ message: messages.orders.completed });
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}));

// 取消订单：志愿者预约前撤回 / 居民取消。
// 原子地关闭进行中订单、记录原因与取消人、释放需求供其他志愿者重新接单。
router.post('/:id/cancel', authenticateToken, asyncHandler(async (req, res) => {
  const { reason } = req.body;
  const cancelReason = typeof reason === 'string' ? reason.trim() : '';
  const orderId = req.params.id;
  const operatorId = req.user.id;
  const conn = await pool.getConnection();

  if (!cancelReason) {
    return res.status(400).json({ message: messages.orders.missingCancelReason });
  }

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

    if (order.user_id !== operatorId && order.volunteer_id !== operatorId) {
      await conn.rollback();
      return res.status(403).json({ message: messages.orders.forbidden });
    }

    // 已完成的订单禁止取消
    if (order.status === 'completed') {
      await conn.rollback();

      const [reviews] = await pool.query(
        'SELECT id FROM reviews WHERE order_id = ? LIMIT 1',
        [orderId],
      );
      return res.status(400).json({
        message: reviews.length > 0
          ? messages.orders.cannotCancelReviewed
          : messages.orders.cannotCancelCompleted,
      });
    }

    // 已取消的订单禁止重复取消，状态保持不变
    if (order.status === 'cancelled') {
      await conn.rollback();
      return res.status(400).json({ message: messages.orders.alreadyCancelled });
    }

    const [needs] = await conn.query(
      'SELECT * FROM needs WHERE id = ? FOR UPDATE',
      [order.need_id],
    );

    // 已开始（到了预约时间或已记录开始时间）的订单禁止取消
    if (needs.length > 0 && isServiceStarted(order, needs[0])) {
      await conn.rollback();
      return res.status(400).json({ message: messages.orders.cannotCancelStarted });
    }

    // 条件更新保证并发取消只有一次生效
    const [updateResult] = await conn.query(
      `UPDATE orders
       SET status = 'cancelled', cancel_reason = ?, cancelled_by = ?, cancelled_at = NOW()
       WHERE id = ? AND status = 'in_progress'`,
      [cancelReason, operatorId, orderId],
    );

    if (updateResult.affectedRows !== 1) {
      await conn.rollback();
      return res.status(400).json({ message: messages.orders.alreadyCancelled });
    }

    // 释放需求：清空接单志愿者并恢复为待接单，其他志愿者可重新接单
    await conn.query(
      "UPDATE needs SET status = 'pending', volunteer_id = NULL WHERE id = ? AND status = 'accepted'",
      [order.need_id],
    );

    await conn.commit();
    res.json({ message: messages.orders.cancelled });
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}));

router.post('/:id/review', authenticateToken, asyncHandler(async (req, res) => {
  const { rating, comment } = req.body;
  const orderId = req.params.id;
  const [orders] = await pool.query('SELECT * FROM orders WHERE id = ?', [orderId]);

  if (orders.length === 0) {
    return res.status(404).json({ message: messages.orders.notFound });
  }

  // 只有已完成的订单可以评价，进行中或已取消的订单禁止评价
  if (orders[0].status !== 'completed') {
    return res.status(400).json({ message: messages.orders.cannotReviewStatus });
  }

  const targetId = orders[0].user_id === req.user.id
    ? orders[0].volunteer_id
    : orders[0].user_id;

  await pool.query(
    'INSERT INTO reviews (order_id, reviewer_id, target_id, rating, comment) VALUES (?, ?, ?, ?, ?)',
    [orderId, req.user.id, targetId, rating, comment],
  );

  res.json({ message: messages.orders.reviewed });
}));

module.exports = router;
