import fs from "node:fs";
import { execSync } from "node:child_process";

const files = fs.readdirSync("tests").filter(f => f.endsWith(".mjs") && f.startsWith("test-"));
let totalFiles = 0;
let passedFiles = 0;

for (const f of files) {
  totalFiles++;
  process.stdout.write(`Testing ${f}... `);
  try {
    execSync(`node tests/${f}`, { stdio: "pipe" });
    passedFiles++;
    console.log("PASS");
  } catch (e) {
    console.log("FAIL");
    console.error(e.stderr?.toString() || e.stdout?.toString());
  }
}
console.log(`\nResults: ${passedFiles}/${totalFiles} test files passed.`);
if (passedFiles !== totalFiles) process.exit(1);
