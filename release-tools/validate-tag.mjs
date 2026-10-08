import {readFile} from 'node:fs/promises';
const pkg=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8'));
if(process.env.GITHUB_REF_TYPE!=='tag' || process.env.GITHUB_REF_NAME!==`v${pkg.version}`
   || !/^\d+\.\d+\.\d+$/.test(pkg.version)) throw new Error('Release tag must exactly match package.json');
console.log(`Release tag verified: v${pkg.version}`);
