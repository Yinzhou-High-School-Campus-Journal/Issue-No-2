# 贡献说明

本仓库主要供我刊编辑部相关成员使用，本文档为具体操作指南。

### 稿件工作流程

- 技术员接收投稿；
- 技术员将稿件 Markdown 化、写上元数据并 Commit（贡献）到对应责编的文件夹；
- 责编粗修标点与错别字；
- 责编可选进行下一步的修改工作（如添加注释）；
- 责编与作者联系确认（建议使用腾讯文档或 QQ）；
- 责编提交会被[机器人](https://github.com/YzCJ-Bot)自动批准、合并的 Pull Request（拉取请求，PR）；
- 稿件进入公审阶段，所有编辑可用 Issues（议题）提出大方向建议，PR 提出具体建议；
- 责编评论审核并与作者再次确认后合并进 `main` 分支。

### 目前稿件目录 

- 文章/
    - 正文之外（张哲源、李洛霄）/
    - 人文社科（张哲源）/
    - 创意写作（李洛霄）/
    - 创意写作（叶静轩）/
    - 其他（不实际存在，日后拓展用）/

### 元数据

#### 格式（YAML）

```
---
title: "文章标题"
author: "班级 作者"
author_display: "作者实际署名"
received_date: "yyyy-mm-dd"
editor: "对应责编"
editor_username: "对应责编的 GitHub 用户名"
status: "文章状态"
note: "额外备注" 
---
```

注：「正文之外」及其余创作中内容须将 `received_date` 改为 `create_date`

#### status（状态）选项

- 适用于「正文之外」及其余创作中内容
    - 未开始
    - 写作中
- 适用于外来投稿
    - 待责编审阅
    - 编审未通过
    - 编辑中
    - 待作者确认
- 均可适用
    - 公审中
    - 校审中
    - 校审未通过
    - 已定稿
    - 已见刊

### 提交规则

1. 责编对其负责的稿件有最终决定权；
2. 稿件必须使用 Markdown 格式提交；
3. 稿件开头必须包含规定元数据（不得删除 "）；
4. 所有非新增稿件性修改须通过 PR；
5. 无权限人员提出 PR 时，需等待被 CODEOWNERS 通知的对应责编处理；
6. PR 的说明须具有概括性、可读性，不要「Update」「微调一下」而要「修复了第三段的错别字」「添加了注释」；
7. 禁止提交作者隐私内容（如私人联系方式）、未获授权的稿件以及与校刊无关的文件。

### Markdown 稿件注意事项

- 带空格的井号（# ）后加文字代表标题（层级）
    - 「# 」对应 Craft 中的大标题或文件名，一般出现在文首，现已被元数据替代
    - 「## 」对应副标题，较少见
    - 「### 」对应中标题，一般用于正文以外部分，如后记、注释等
    - 「#### 」对应小标题，一般用于正文之内部分，如「一、」「二、」「三、」
- 如果你对其余 Markdown 写法有疑问
    - 可以参考 GitHub Docs 官方的 [*Basic Writing and Formatting Syntax*](https://docs.github.com/en/get-started/writing-on-github/getting-started-with-writing-and-formatting-on-github/basic-writing-and-formatting-syntax)（《基本写作与格式语法》）。注意，请直接通过如 Chrome 的自动翻译等功能阅读英文版，而不要被「诱骗」到那个不堪入目的机翻简中版
    - 也可以参考更（最）进阶、权威的 *GitHub Flavored Markdown Spec*（《GitHub 风格的 Markdown 规范》），这是[第三方中文版](https://gfm.docschina.org/zh-hans/)，而这是[官方英文版](https://github.github.com/gfm/#insecure-characters)
- 所有双层蝌蚪引号（“”）、傻瓜引号（""）应改为单层直角引号（「」），单层蝌蚪引号（‘’）应改为双层直角引号（『』）
- 不进入 InDesign 排版的文件（如 `README.md`），为保持美观，汉字与西文字母、数字间应加入一个空格
- 进入排版流程的文件则不用添加任何空格，InDesign 的排版引擎会自动添加
- 对其他排版细则有疑问的可参考 W3C（万维网联盟，World Wide Web Consortium）的[中文排版需求](https://www.w3.org/TR/clreq/)
