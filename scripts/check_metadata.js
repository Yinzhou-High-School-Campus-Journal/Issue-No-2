const fs = require("fs");
const {
  loadConfig,
  parseFrontmatter,
  validateMetadata,
  listArticleFiles
} = require("./journal_rules");

function main() {
  const config = loadConfig();
  const files = listArticleFiles(config);
  const errors = [];

  for (const file of files) {
    try {
      const text = fs.readFileSync(file, "utf8");
      const data = parseFrontmatter(text, file);
      validateMetadata(config, file, data);
    } catch (error) {
      errors.push(error.message);
    }
  }

  if (errors.length > 0) {
    console.log("元数据检查失败：");
    for (const error of errors) {
      console.log(`- ${error}`);
    }
    process.exit(1);
  }

  console.log(`元数据检查通过。共检查 ${files.length} 个稿件文件。`);
}

main();
