const fs = require('fs');
const { execSync } = require('child_process');
try {
  fs.writeFileSync('git-out.txt', execSync('git status && git branch && git log -n 3 --oneline').toString());
} catch (e) {
  fs.writeFileSync('git-out.txt', e.toString() + (e.stdout ? e.stdout.toString() : ''));
}
