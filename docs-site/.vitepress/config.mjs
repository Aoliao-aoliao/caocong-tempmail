import { defineConfig } from 'vitepress';

export default defineConfig({
  lang: 'zh-CN', title: '草丛临时邮箱文档',
  description: '从安装到收信，按步骤搭建和维护自己的 草丛临时邮箱。作者：草丛。',
  srcDir: 'content', cleanUrls: false,
  base: '/caocong-tempmail/',
  head: [['link', { rel: 'icon', type: 'image/svg+xml', href: '/caocong-tempmail/favicon.svg' }]],
  themeConfig: {
    logo: '/brand.jpg', siteTitle: '草丛临时邮箱',
    nav: [{ text: '搭建教程', link: '/panel' }, { text: '后台说明', link: '/admin-guide' }, { text: '用户指南', link: '/user-guide' }, { text: '支付对接', link: '/payments' }, { text: '常见问题', link: '/troubleshooting' }, { text: '演示站', link: 'https://nodemail.513399.xyz/' }],
    socialLinks: [{ icon: 'github', link: 'https://github.com/Aoliao-aoliao/caocong-tempmail', ariaLabel: 'GitHub 项目源码' }],
    sidebar: [
      { text: '开始之前', items: [{ text: '先了解 草丛临时邮箱', link: '/introduction' }, { text: '准备服务器与域名', link: '/preparation' }] },
      { text: '安装', items: [{ text: '1Panel 图文搭建', link: '/panel' }, { text: 'Linux 命令行搭建', link: '/linux' }, { text: '安装参数与网络', link: '/installation' }] },
      { text: '把网站用起来', items: [{ text: '第一次进入后台', link: '/admin' }, { text: '后台功能说明', link: '/admin-guide' }, { text: '用户使用指南', link: '/user-guide' }] },
      { text: '收信与账号接入', items: [{ text: '域名与收信', link: '/mail' }, { text: '中继邮箱 · Gmail / Outlook', link: '/relay-setup' }, { text: '人机验证 · Turnstile', link: '/turnstile' }, { text: '找回密码 · 发信邮箱', link: '/password-mail' }, { text: 'NodeLoc 登录与绑定', link: '/nodeloc-login' }, { text: 'Telegram 绑定', link: '/telegram' }, { text: '第三方接入总览', link: '/integrations' }] },
      { text: '支付对接', items: [{ text: '渠道选择与充值档位', link: '/payments' }, { text: 'NodeLoc 能量支付 · 逐项配置', link: '/payment-nodeloc' }, { text: 'USDT 网关 · 逐项配置', link: '/payment-usdt' }] },
      { text: '日常维护', items: [{ text: '更新与恢复', link: '/upgrading' }, { text: '备份自己的数据', link: '/backup' }, { text: '问题排查', link: '/troubleshooting' }] },
      { text: '项目信息', items: [{ text: '数据存在哪里', link: '/data' }, { text: '测试与功能边界', link: '/validation' }, { text: '版权与署名', link: '/copyright' }, { text: '发布与许可状态', link: '/license' }] }
    ],
    search: { provider: 'local', options: { translations: {
      button: { buttonText: '搜索文档', buttonAriaLabel: '搜索文档' },
      modal: { displayDetails: '显示摘要', resetButtonTitle: '清空', backButtonTitle: '返回', noResultsText: '没有找到相关内容，试试“502”“收信”或“备份”。', footer: { selectText: '选择', navigateText: '切换', closeText: '关闭' } }
    } } },
    outline: { level: [2, 3], label: '本页目录' },
    sidebarMenuLabel: '文档目录', returnToTopLabel: '回到顶部',
    darkModeSwitchLabel: '切换外观', lightModeSwitchTitle: '浅色', darkModeSwitchTitle: '深色',
    docFooter: { prev: '上一篇', next: '下一篇' },
    footer: { message: 'AGPL-3.0 · 草丛临时邮箱', copyright: 'Copyright © 2026 草丛（Aoliao-aoliao） · 草丛临时邮箱' }
  }
});
