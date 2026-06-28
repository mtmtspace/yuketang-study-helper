// 刷课用选择器集中层。已据 output/watch-inspect 现场核验（2026-06-27，长江雨课堂新版「学习内容」）。
//
// 关键结构：
//  · 「学习内容」列表在一个 iframe 内：URL 含 studycontent（…/pro/lms/<school>/<cls>/studycontent?...&iframe_from=ykt）。
//    叶子单元 = .leaf-detail（标题 .leaf-title，状态/完成度 .progress-wrap，类型靠图标 class：icon--shipin 视频 / icon--taolun 讨论 …）。
//  · 点叶子是「整个标签页顶层跳转」到详情页：视频 …/xcloud/video-student/<cls>/<id>，讨论 …/lms/<cls>/forum/<id>。
//  · 详情页在顶层主文档（非 iframe）。
// 值均为字符串/数组（可安全传入 page.evaluate；不放 RegExp）。

export const SEL = {
  // —— 顶部页签（studentLog 页，el-tabs）——
  tabContent: "#tab-content", // 学习内容（id 最稳）
  tabContentText: "学习内容", // 文本兜底

  // —— 学习内容内容所在 iframe（按 URL 关键字识别）——
  contentFrameUrl: ["studycontent", "/pro/lms/"],

  // —— iframe 内：叶子单元 ——
  leaf: {
    row: ".leaf-detail", // 单元容器（核验：66 个 = 目录总数）
    title: ".leaf-title", // 标题
    progress: ".progress-wrap", // 状态/完成度文本
    // 类型：在行内按 [class*=关键字] 找图标（icon--shipin / icon--taolun1 …）
    icon: {
      video: ["shipin", "bofang"],
      discuss: ["taolun"],
      read: ["tuwen", "kejian", "ppt", "doc", "pdf", "yuxi"],
      exercise: ["zuoye", "lianxi", "ceshi"],
    },
    // 全局展开（“内容总览 展开/收起”）与章节头，确保叶子可见
    expandText: ["展开"],
    chapterHeader: [".content-overview .header", ".common-chapter", ".chapter-list .header"],
  },
  // 行内状态文本（done 判定）
  statusDoneText: ["已完成", "已学完", "已结束"],

  // —— 详情页 URL 判类型 ——
  urlKind: {
    video: ["video-student", "/xcloud/video"],
    discuss: ["/forum"],
    exercise: ["exercise", "homework", "/exam", "/quiz", "test_paper"],
  },

  // —— 视频播放器（xt player；顶层主文档）——
  player: {
    root: "#video-box, .xtplayer, [class*='xt_video_player_container']",
    video: "video",
    playBtn: ["xt-playbutton.xt_video_player_play_btn", "xt-bigbutton", ".xt_video_player_play_btn"],
    progressText: ["div.progress-wrap", "span.text", "div.title-fr"], // “完成度：X%”
    // 播放器 UI 控件（点它们让“静音/倍速”作用到播放器自身，并让 UI 标签同步）
    ui: {
      root: "#video-box, .xtplayer, [class*='xt_video_player_container']",
      speedBtn: "xt-speedbutton.xt_video_player_speed, .xt_video_player_speed",
      speedValue:
        "xt-speedbutton.xt_video_player_speed > xt-speedvalue, xt-speedvalue.xt_video_player_common_value, .xt_video_player_speed .xt_video_player_common_value", // 显示 “1.00X”
      speedScope: "xt-speedbutton.xt_video_player_speed, .xt_video_player_speed",
      speedItem: "xt-speedlist [keyt], .xt_video_player_speed [keyt], xt-speedlist li, .xt_video_player_speed li", // keyt="2.00"
      volumeBtn: "xt-volumebutton.xt_video_player_volume, .xt_video_player_volume", // 文本 “80%”/“0%”
      volumeIcon:
        "xt-volumebutton.xt_video_player_volume > xt-icon, .xt_video_player_volume > .xt_video_player_common_icon, .xt_video_player_volume xt-icon", // 点它切换静音
    },
  },

  // —— 讨论区（讨论页 /forum 与视频页评论同组件）——
  discuss: {
    list: ["div.new_discuss_list"], // 评论列表容器
    item: "dl", // 每条评论；第一个 = 最新
    body: ["div.cont_detail"], // 评论正文
    input: ["textarea.el-textarea__inner", "div#publish textarea", "textarea", '[contenteditable="true"]'],
    sendText: ["发送"],
  },

  doneThreshold: 95, // 完成度 ≥95% 视为完成
};
