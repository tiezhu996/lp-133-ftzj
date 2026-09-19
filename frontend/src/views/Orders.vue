<template>
  <div class="min-h-screen bg-gray-50">
    <div class="container mx-auto px-4 py-6">
      <h1 class="text-2xl font-bold text-gray-800 mb-6">我的订单</h1>
      
      <el-card class="mb-6">
        <el-tabs v-model="activeTab" @tab-change="fetchOrders">
          <el-tab-pane label="进行中" name="in_progress" />
          <el-tab-pane label="已完成" name="completed" />
          <el-tab-pane label="已取消" name="cancelled" />
          <el-tab-pane label="全部" name="" />
        </el-tabs>
      </el-card>
      
      <div v-if="loading" class="text-center py-16">
        <el-icon class="animate-spin text-4xl text-gray-400"><Loading /></el-icon>
      </div>
      
      <div v-else-if="orders.length === 0" class="text-center py-16">
        <el-icon class="text-6xl text-gray-300"><Document /></el-icon>
        <p class="mt-4 text-gray-500">暂无订单</p>
      </div>
      
      <div v-else class="space-y-4">
        <el-card v-for="order in orders" :key="order.id" class="hover:shadow-md">
          <div class="flex items-start justify-between">
            <div class="flex-1">
              <div class="flex items-center mb-2">
                <h3 class="font-medium text-lg mr-3">{{ order.title }}</h3>
                <el-tag :type="getTypeColor(order.type)" size="small">
                  {{ getTypeName(order.type) }}
                </el-tag>
                <el-tag v-if="order.status === 'in_progress'" type="warning" class="ml-2" size="small">进行中</el-tag>
                <el-tag v-else-if="order.status === 'completed'" type="success" class="ml-2" size="small">已完成</el-tag>
                <el-tag v-else-if="order.status === 'cancelled'" type="danger" class="ml-2" size="small">已取消</el-tag>
              </div>

              <div class="text-gray-600 text-sm mb-3">
                <p v-if="user?.role === 'volunteer'">
                  <el-icon class="mr-1"><User /></el-icon>
                  服务对象：{{ order.user_name }}
                </p>
                <p v-else>
                  <el-icon class="mr-1"><Service /></el-icon>
                  志愿者：{{ order.volunteer_name }}
                </p>
                <p class="mt-1">
                  <el-icon class="mr-1"><Location /></el-icon>
                  {{ order.address }}
                </p>
                <p v-if="order.expected_time" class="mt-1">
                  <el-icon class="mr-1"><Calendar /></el-icon>
                  预约时间：{{ new Date(order.expected_time).toLocaleString() }}
                </p>
                <p v-if="order.service_hours" class="mt-1">
                  <el-icon class="mr-1"><Clock /></el-icon>
                  服务时长：{{ order.service_hours }} 小时
                </p>
                <div
                  v-if="order.status === 'cancelled' && order.cancel_reason"
                  class="mt-2 p-2 bg-red-50 rounded text-xs text-red-600 leading-relaxed"
                >
                  <p>
                    <el-icon class="mr-1"><CircleClose /></el-icon>
                    取消人：{{ order.cancelled_by_name || '未知用户' }}
                    <span class="ml-1 text-gray-400">
                      ({{ order.cancelled_by === user?.id ? '我' : cancelRole(order) }})
                    </span>
                  </p>
                  <p class="mt-1">取消原因：{{ order.cancel_reason }}</p>
                  <p v-if="order.cancelled_at" class="mt-1">
                    取消时间：{{ new Date(order.cancelled_at).toLocaleString() }}
                  </p>
                </div>
              </div>

              <div class="text-xs text-gray-400">
                下单时间：{{ new Date(order.created_at).toLocaleString() }}
              </div>
            </div>

            <div class="flex flex-col gap-2">
              <el-button
                v-if="order.status === 'in_progress'"
                type="primary"
                size="small"
                @click="handleComplete(order)"
              >
                完成服务
              </el-button>
              <el-button
                v-if="order.status === 'in_progress'"
                type="danger"
                size="small"
                :loading="cancellingId === order.id"
                @click="handleCancel(order)"
              >
                {{ user?.role === 'volunteer' ? '撤回接单' : '取消订单' }}
              </el-button>
              <el-button
                v-if="order.status === 'completed' && !hasReviewed(order.id)"
                type="success"
                size="small"
                @click="showReviewDialog(order)"
              >
                去评价
              </el-button>
              <el-button
                type="text"
                size="small"
                @click="handleMessage(order)"
              >
                <el-icon class="mr-1"><ChatDotRound /></el-icon>
                发消息
              </el-button>
            </div>
          </div>
        </el-card>
      </div>
    </div>
    
    <el-dialog v-model="reviewDialogVisible" title="服务评价" width="500px">
      <el-form :model="reviewForm" label-width="80px">
        <el-form-item label="评分">
          <el-rate v-model="reviewForm.rating" :max="5" show-score />
        </el-form-item>
        <el-form-item label="评价内容">
          <el-input v-model="reviewForm.comment" type="textarea" :rows="3" placeholder="请输入评价内容" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="reviewDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submittingReview" @click="submitReview">提交评价</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, onMounted, computed } from 'vue'
import { useRouter } from 'vue-router'
import { useUserStore } from '@/stores/user'
import api from '@/utils/api'
import { ElMessage, ElMessageBox } from 'element-plus'

const router = useRouter()
const userStore = useUserStore()
const user = computed(() => userStore.user)

const orders = ref([])
const loading = ref(false)
const activeTab = ref('in_progress')
const reviewDialogVisible = ref(false)
const submittingReview = ref(false)
const cancellingId = ref(null)
const currentOrder = ref(null)
const reviewedOrders = ref([])

const reviewForm = ref({
  rating: 5,
  comment: ''
})

const typeMap = {
  accompany: { name: '陪聊陪诊', color: 'blue' },
  shopping: { name: '代买代办', color: 'green' },
  repair: { name: '家电维修', color: 'orange' },
  housework: { name: '家政服务', color: 'purple' },
  other: { name: '其他帮助', color: 'gray' }
}

const getTypeName = (type) => typeMap[type]?.name || type
const getTypeColor = (type) => typeMap[type]?.color || 'info'

const hasReviewed = (orderId) => reviewedOrders.value.includes(orderId)

// 取消人是当前订单的志愿者还是居民（排除“我”本人的情况）
const cancelRole = (order) => {
  if (order.cancelled_by === order.volunteer_id) return '志愿者撤回'
  if (order.cancelled_by === order.user_id) return '居民取消'
  return ''
}

const fetchOrders = async () => {
  loading.value = true
  try {
    const params = activeTab.value ? { status: activeTab.value } : {}
    const res = await api.get('/orders', { params })
    orders.value = res.data.orders
  } finally {
    loading.value = false
  }
}

const handleComplete = async (order) => {
  try {
    await ElMessageBox.confirm('确认服务已完成吗？', '完成确认', {
      confirmButtonText: '确定',
      cancelButtonText: '取消',
      type: 'info'
    })

    await api.put(`/orders/${order.id}/complete`, { service_hours: 1 })
    ElMessage.success('服务已完成')
    fetchOrders()
    userStore.fetchUserInfo()
  } catch (e) {
    if (e !== 'cancel') {
      ElMessage.error(e.response?.data?.message || '操作失败')
    }
  }
}

const handleCancel = async (order) => {
  const isVolunteer = user.value.role === 'volunteer'
  try {
    const { value } = await ElMessageBox.prompt(
      isVolunteer
        ? '撤回后需求将重新开放给其他志愿者接单，请填写撤回原因。'
        : '取消后需求将重新开放，其他志愿者可重新接单，请填写取消原因。',
      isVolunteer ? '撤回接单' : '取消订单',
      {
        confirmButtonText: '确定',
        cancelButtonText: '再想想',
        inputType: 'textarea',
        inputPlaceholder: '请填写取消原因（必填）',
        inputValidator: (val) => (val && val.trim() ? true : '取消原因不能为空')
      }
    )

    cancellingId.value = order.id
    await api.post(`/orders/${order.id}/cancel`, { reason: value.trim() })
    ElMessage.success(isVolunteer ? '已撤回接单' : '订单已取消')
    fetchOrders()
  } catch (e) {
    if (e !== 'cancel') {
      ElMessage.error(e.response?.data?.message || '取消失败')
    }
  } finally {
    cancellingId.value = null
  }
}

const showReviewDialog = (order) => {
  currentOrder.value = order
  reviewForm.value = { rating: 5, comment: '' }
  reviewDialogVisible.value = true
}

const submitReview = async () => {
  try {
    submittingReview.value = true
    await api.post(`/orders/${currentOrder.value.id}/review`, reviewForm.value)
    reviewedOrders.value.push(currentOrder.value.id)
    ElMessage.success('评价成功')
    reviewDialogVisible.value = false
  } catch (e) {
    ElMessage.error(e.response?.data?.message || '评价失败')
  } finally {
    submittingReview.value = false
  }
}

const handleMessage = (order) => {
  const otherUserId = user.value.role === 'volunteer' ? order.user_id : order.volunteer_id
  router.push({
    path: '/messages',
    query: { userId: otherUserId }
  })
}

onMounted(() => {
  fetchOrders()
})
</script>
