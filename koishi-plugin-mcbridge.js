// ============================================================
//   koishi-plugin-mcbridge  (Koishi 侧插件)
//   群服互通：开一个 WebSocket 服务端，等 BDS(LSE) 端 MCBridge 连入。
//   提供：群↔服消息互通、查服、查排行榜
//
//   依赖：需要在 Koishi 目录安装 ws 包：  npm i ws
//   放置：把本文件放进 Koishi 的 external/ 或作为本地插件加载；
//        在 koishi.yml 里以插件形式启用，并填好配置。
//
//   适配：以 Koishi v4 为主（当前主流版本）。若你用 v3，文末有说明。
// ============================================================

const { Schema, Logger } = require('koishi')
const { WebSocketServer } = require('ws')

const logger = new Logger('mcbridge')

exports.name = 'mcbridge'

// ---- 插件配置项（会显示在 Koishi 控制台）----
exports.Config = Schema.object({
  port: Schema.number().default(8920).description('WebSocket 服务监听端口（与 BDS 端 wsUrl 的端口一致）'),
  token: Schema.string().default('change_me_please').description('连接密钥（与 BDS 端 token 一致）'),
  groups: Schema.array(Schema.string()).default([]).description('互通的群号（频道ID）列表，可填多个'),
  relayGroupToServer: Schema.boolean().default(true).description('是否把群消息转发到服务器'),
  relayServerToGroup: Schema.boolean().default(true).description('是否把服务器消息转发到群'),
  defaultBoard: Schema.string().default('kills').description('查排行榜默认读取的计分板名称'),
})

exports.apply = (ctx, config) => {
  let mcSocket = null          // 当前连接的 BDS 端 socket
  let mcAuthed = false         // 是否已通过鉴权
  const pending = new Map()    // 查询请求的回调表： id -> resolve 函数
  let reqId = 0

  // ---------- 启动 WebSocket 服务端 ----------
  const wss = new WebSocketServer({ port: config.port })
  logger.info(`WebSocket 服务已启动，监听端口 ${config.port}，等待 BDS 端连入...`)

  wss.on('connection', (socket) => {
    logger.info('有 BDS 端尝试连接...')

    socket.on('message', (raw) => {
      let data
      try { data = JSON.parse(raw.toString()) } catch (e) { return }
      if (!data || !data.type) return

      switch (data.type) {
        // BDS 端鉴权
        case 'auth':
          if (data.token === config.token) {
            mcSocket = socket
            mcAuthed = true
            socket.send(JSON.stringify({ type: 'auth_ok' }))
            logger.info('BDS 端鉴权成功，群服互通已就绪')
          } else {
            socket.send(JSON.stringify({ type: 'auth_fail' }))
            logger.warn('BDS 端鉴权失败：token 不一致')
            socket.close()
          }
          break

        // 服务器聊天 → 群
        case 'chat':
          if (config.relayServerToGroup) {
            sendToGroups(`[服务器] ${data.player}: ${data.message}`)
          }
          break

        // 进服 / 退服 → 群
        case 'join':
          if (config.relayServerToGroup) sendToGroups(`[+] ${data.player} 进入了服务器（在线 ${data.online}）`)
          break
        case 'left':
          if (config.relayServerToGroup) sendToGroups(`[-] ${data.player} 离开了服务器（在线 ${data.online}）`)
          break

        // 查询结果 → 唤醒对应的等待者
        case 'serverInfoResult':
        case 'leaderboardResult':
          if (pending.has(data.id)) {
            pending.get(data.id)(data)
            pending.delete(data.id)
          }
          break
      }
    })

    socket.on('close', () => {
      if (socket === mcSocket) { mcSocket = null; mcAuthed = false; logger.warn('BDS 端连接已断开') }
    })
    socket.on('error', () => {})
  })

  ctx.on('dispose', () => { try { wss.close() } catch (e) {} })

  // ---------- 工具：把文字发到所有配置的群 ----------
  function sendToGroups(text) {
    for (const bot of ctx.bots) {
      for (const g of config.groups) {
        bot.sendMessage(g, text).catch(() => {})
      }
    }
  }

  // ---------- 工具：向 BDS 端发查询并等待结果 ----------
  function queryServer(what, extra = {}, timeout = 5000) {
    return new Promise((resolve) => {
      if (!mcSocket || !mcAuthed) { resolve(null); return }
      const id = ++reqId
      pending.set(id, resolve)
      mcSocket.send(JSON.stringify(Object.assign({ type: 'query', what, id }, extra)))
      // 超时保护
      setTimeout(() => {
        if (pending.has(id)) { pending.delete(id); resolve(null) }
      }, timeout)
    })
  }

  // ---------- 群消息 → 服务器 ----------
  ctx.on('message', (session) => {
    if (!config.relayGroupToServer) return
    if (!mcSocket || !mcAuthed) return
    // 只转发配置的群
    if (!config.groups.includes(session.channelId)) return
    // 跳过指令（以 / 或 . 开头的认为是命令）
    const content = (session.content || '').trim()
    if (!content || content.startsWith('/') || content.startsWith('.')) return

    mcSocket.send(JSON.stringify({
      type: 'chat',
      user: session.username || session.userId,
      message: content
    }))
  })

  // ---------- 命令：查服 ----------
  ctx.command('查服', '查询服务器在线情况').action(async () => {
    if (!mcSocket || !mcAuthed) return '服务器当前未连接 ❌'
    const res = await queryServer('serverInfo')
    if (!res || !res.data) return '查询超时，服务器可能离线 ⏱'
    const d = res.data
    let msg = `🎮 服务器状态\n在线人数：${d.online}`
    if (d.players && d.players.length) msg += `\n在线玩家：${d.players.join('、')}`
    if (d.version) msg += `\n版本：${d.version}`
    return msg
  })

  // ---------- 命令：查排行榜 [计分板名] ----------
  ctx.command('查排行榜 [board]', '查询计分板排行榜').action(async ({ }, board) => {
    if (!mcSocket || !mcAuthed) return '服务器当前未连接 ❌'
    const res = await queryServer('leaderboard', { board: board || config.defaultBoard })
    if (!res || !res.data) return '查询超时，服务器可能离线 ⏱'
    if (res.data.error) return '❌ ' + res.data.error
    const list = res.data.list || []
    if (!list.length) return '暂无排行榜数据'
    let msg = `🏆 排行榜【${res.board}】\n`
    list.forEach((it, i) => {
      const medal = ['🥇', '🥈', '🥉'][i] || `${i + 1}.`
      msg += `${medal} ${it.name}  ${it.score}\n`
    })
    return msg.trim()
  })

  logger.info('mcbridge 插件已加载')
}

// ============================================================
//  【如果你用 Koishi v3】需要做的小改动：
//   1) v3 没有 Schema 控制台配置，apply 的第二个参数就是你在配置文件里写的对象，
//      可删掉 exports.Config，直接在 apply 里给 config 设默认值：
//        config = Object.assign({ port:8920, token:'...', groups:[], ... }, config)
//   2) 发送群消息：v3 用 bot.sendMessage(channelId, content)（同 v4，一般无需改）
//   3) 命令定义 ctx.command(...).action(...) 在 v3/v4 基本一致
//   4) ctx.on('message', cb) 在 v3/v4 一致
//  其余逻辑通用。
// ============================================================
