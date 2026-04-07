# COC Docs → PDF Builder

把 COC 项目的 markdown 文档（BP / 生态规划 / 白皮书 / Pitch Deck）转换为正式排版的 PDF。

## 关键设计

- **CJK 等宽字体**：使用 `Noto Sans Mono CJK SC` 渲染所有 `<pre>` 代码块，**保证 ASCII 框图的边框字符 (╔ ║ ═ 等) 在中文混排时仍然完美对齐**
- **正式中文排版**：A4，11pt 正文，`Noto Sans CJK SC` 主字体，自动断字、左右两端对齐、孤行控制
- **页码**：每页底部居中 `当前页 / 总页数`
- **表格**：深蓝表头 + 斑马纹 + 自动换行
- **代码块**：6.8pt 等宽字体（足以容纳 4 列宽表格 / 60+ 字符 ASCII 框图）

## 系统依赖

- **Node.js 20+**
- **Google Chrome / Chromium** (用于 headless PDF 渲染)
- **Noto Sans CJK SC** + **Noto Sans Mono CJK SC** 字体

Linux 安装字体：
```bash
sudo apt install fonts-noto-cjk fonts-noto-cjk-extra
```

## 使用

### 安装依赖
```bash
cd scripts/pdf-build
npm install
```

### 单文件构建
```bash
npm run build:bp:zh        # 商业计划书 中文
npm run build:bp:en        # 商业计划书 英文
npm run build:roadmap:zh   # 生态规划 中文
npm run build:roadmap:en   # 生态规划 英文
npm run build:wp:zh        # 白皮书 中文
npm run build:wp:en        # 白皮书 英文
npm run build:pitch:zh     # Pitch Deck 中文
```

### 一次构建全部
```bash
npm run build:all
```

### 自定义文件
```bash
node build.mjs <input.md> <output.pdf>
```

## 输出位置

所有 PDF 输出到 `docs/` 目录，与对应的 markdown 同目录。

## 验证 PDF 质量

```bash
# 查看页数和元数据
pdfinfo docs/COC_business_plan.zh.pdf

# 提取文本验证内容完整性
pdftotext -layout docs/COC_business_plan.zh.pdf /tmp/check.txt
```

## 已知排版特性

- **ASCII 框图**：使用 6.8pt 等宽字体，60+ 字符宽框图可完整显示在 A4 内
- **宽表格**：4 列以上的代码块表格 (如 §4.3 节点收入示例) 通过减小字号避免裁断
- **页边距**：上 18mm / 下 20mm / 左右 14mm，最大化内容密度
- **页眉/页脚**：无 Chrome 默认页眉，仅页脚保留页码

## 故障排查

### 中文显示为方框
缺少 `Noto Sans CJK SC` 字体。安装 `fonts-noto-cjk` 包。

### ASCII 框图对不齐
缺少 `Noto Sans Mono CJK SC` 字体。这是关键字体，必须有。

### Chrome 报错 "Failed to launch"
某些环境需要 `--no-sandbox` (build.mjs 已默认包含)。

### 字号过小
修改 `build.mjs` 中 `pre { font-size: 6.8pt; }` 调高，但注意宽表格可能被裁。

## 更新策略

每当 BP / 生态规划 / 白皮书 / Pitch Deck 任何源 markdown 文件更新后，
重新运行对应的 `npm run build:*` 即可同步 PDF。建议在 commit 前重新生成 PDF。
