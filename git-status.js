const { execSync } = require('child_process');
console.log(execSync('git status').toString());
console.log(execSync('git log -n 5 --oneline').toString());
