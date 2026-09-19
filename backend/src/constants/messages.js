module.exports = {
  health: '志愿者互助平台服务正常',
  auth: {
    unauthorized: '未授权访问',
    invalidToken: 'Token无效',
  },
  errors: {
    notFound: '接口不存在',
    internal: '服务器错误',
  },
  authFlow: {
    missingRegisterFields: '请填写必填项',
    phoneRegistered: '该手机号已注册',
    registerSuccess: '注册成功',
    missingLoginFields: '请输入手机号和密码',
    userNotFound: '用户不存在',
    wrongPassword: '密码错误',
    loginSuccess: '登录成功',
  },
  user: {
    notFound: '用户不存在',
    updated: '更新成功',
  },
  needs: {
    missingFields: '请填写标题和类型',
    created: '发布成功',
    notFound: '需求不存在',
    alreadyAccepted: '该需求已被接单',
    cannotAcceptOwnNeed: '不能接自己发布的需求',
    accepted: '接单成功',
  },
  orders: {
    notFound: '订单不存在',
    forbidden: '无权限操作',
    completed: '服务已完成',
    reviewed: '评价成功',
    reasonRequired: '请填写取消原因',
    cannotCancel: '已开始、已完成或已评价的订单不能取消',
    cancelled: '订单已取消，需求已重新开放',
    alreadyStarted: '订单已开始服务，不能重复操作',
    startForbidden: '只有接单的志愿者可以开始服务',
    started: '服务已开始',
    completeNotAllowed: '订单当前状态不可完成服务',
    reviewNotAllowed: '只有已完成的订单才能评价',
    alreadyReviewed: '该订单已评价，不能重复评价',
  },
  messages: {
    missingFields: '请填写接收者和内容',
    sent: '发送成功',
  },
  rewards: {
    giftNotFound: '礼品不存在',
    insufficientPoints: '积分不足',
    exchanged: '兑换成功',
  },
  server: {
    started: '志愿者互助平台后端服务启动成功',
  },
};
