import { defineConfig } from 'vitepress';

export default defineConfig({
  lang: 'zh-CN', title: 'NodeMail 文档',
  description: '从安装到收信，按步骤搭建和维护自己的 NodeMail。作者：草丛。',
  srcDir: 'content', cleanUrls: false,
  head: [['meta', { name: 'robots', content: 'noindex, nofollow' }]],
  themeConfig: {
    logo: '/brand.jpg', siteTitle: 'NodeMail',
    nav: [{ text: '搭建教程', link: '/panel' }, { text: '使用与配置', link: '/admin' }, { text: '常见问题', link: '/troubleshooting' }, { text: '源码', link: 'https://github.com/Aoliao-aoliao/nodemail' }],
    sidebar: [
      { text: '开始之前', items: [{ text: '先了解 NodeMail', link: '/introduction' }, { text: '准备服务器与域名', link: '/preparation' }] },
      { text: '安装', items: [{ text: '1Panel 图文搭建', link: '/panel' }, { text: 'Linux 命令行搭建', link: '/linux' }, { text: '安装参数与网络', link: '/installation' }] },
      { text: '把网站用起来', items: [{ text: '第一次进入后台', link: '/admin' }, { text: '域名与收信', link: '/mail' }, { text: '第三方账号与支付', link: '/integrations' }] },
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
    footer: { message: '私有预览 · 正式发布与许可证待确认', copyright: 'Copyright © 2026 草丛（Aoliao-aoliao） · NodeMail' }
  }
});
