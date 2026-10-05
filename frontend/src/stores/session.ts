import { defineStore } from 'pinia'

export const useSessionStore = defineStore('session', {
  state: () => ({
    operator: '值班管理员',
    shiftLabel: '白班 08:00-20:00',
    // 当前值班所属班组：批量发起检查只能提交本班组装置，越权部分会被挡回。
    team: '电气一班',
    scope: '水电站机组运行检修管理平台',
  }),
  getters: {
    canOperate: (state) => state.operator.length > 0,
  },
  actions: {
    setShift(label: string) {
      this.shiftLabel = label
    },
    setTeam(team: string) {
      this.team = team
    },
  },
})
