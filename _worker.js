//================ _worker.js =============================
// 更新日期: 2025-11-04
// 功能: Cloudflare 加速 Docker/GitHub + AWS S3 自动 x-amz 头 + 私有 token + 多重重定向

// 用户配置区域开始 =================================
const ALLOWED_HOSTS = [
  'quay.io', 'gcr.io', 'k8s.gcr.io', 'registry.k8s.io',
  'ghcr.io', 'docker.cloudsmith.io', 'registry-1.docker.io',
  'github.com', 'api.github.com', 'raw.githubusercontent.com',
  'gist.github.com', 'gist.githubusercontent.com'
];

const RESTRICT_PATHS = false;
const ALLOWED_PATHS = ['library', 'user-id-1', 'user-id-2'];

const TOKEN_MAPPING = [
  { url: 'https://raw.githubusercontent.com/is928joe-jpg', env_var: 'REPO_TOKEN_1' },
  { url: 'https://api.github.com/repos/private-org', env_var: 'REPO_TOKEN_2' },
];
// 用户配置区域结束 =================================

// 闪电 SVG
const LIGHTNING_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#FBBF24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"></path></svg>`;

// 首页 HTML（包含 GitHub + Docker 输入界面）
const HOMEPAGE_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Cloudflare 加速</title>
<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,${encodeURIComponent(LIGHTNING_SVG)}">
<script src="https://cdn.tailwindcss.com"></script>
<style>
body{min-height:100vh;display:flex;align-items:center;justify-content:center;font-family:'Inter',sans-serif;padding:1rem;transition:background-color .3s,color .3s}
.light-mode{background:linear-gradient(to bottom right,#f1f5f9,#e2e8f0);color:#111827}
.dark-mode{background:linear-gradient(to bottom right,#1f2937,#374151);color:#e5e7eb}
.container{width:100%;max-width:800px;padding:1.5rem;border-radius:.75rem;border:1px solid #e5e7eb;box-shadow:0 8px 16px rgba(0,0,0,.1)}
.light-mode .container{background:#fff}.dark-mode .container{background:#1f2937}
.section-box{background:linear-gradient(to bottom,#fff,#f3f4f6);border-radius:.5rem;padding:1.5rem;margin-bottom:1.5rem;box-shadow:0 4px 8px rgba(0,0,0,.1)}
.dark-mode .section-box{background:linear-gradient(to bottom,#374151,#1f2937);box-shadow:0 4px 8px rgba(0,0,0,.2)}
.theme-toggle{position:fixed;top:.5rem;right:.5rem;padding:.5rem;font-size:1.2rem}
.toast{position:fixed;bottom:1rem;left:50%;transform:translateX(-50%);background:#10b981;color:#fff;padding:.75rem 1.5rem;border-radius:.5rem;opacity:0;transition:opacity .3s;font-size:.9rem;max-width:90%;text-align:center}
.toast.show{opacity:1}
.result-text{word-break:break-all;overflow-wrap:break-word;font-size:.95rem;max-width:100%;padding:.5rem;border-radius:.25rem;background:#f3f4f6}
.dark-mode .result-text{background:#2d3748}
input[type=text]{background-color:white!important;color:#111827!important}
.dark-mode input[type=text]{background-color:#374151!important;color:#e5e7eb!important}
@media(max-width:640px){.container{padding:1rem}.section-box{padding:1rem;margin-bottom:1rem}h1{font-size:1.5rem;margin-bottom:1.5rem}h2{font-size:1.25rem;margin-bottom:.75rem}p{font-size:.875rem}input{font-size:.875rem;padding:.5rem;min-height:44px}button{font-size:.875rem;padding:.5rem 1rem;min-height:44px}.flex.gap-2{flex-direction:column;gap:.5rem}.github-buttons,.docker-buttons{flex-direction:column;gap:.5rem}.result-text{font-size:.8rem;padding:.4rem}footer{font-size:.75rem}}
</style>
</head>
<body class="light-mode">
<button onclick="toggleTheme()" class="theme-toggle">🌞🌙</button>
<div class="container mx-auto">
<h1 class="text-3xl font-bold text-center mb-8">Cloudflare 加速下载</h1>
<div class="section-box">
<h2 class="text-xl font-semibold mb-2">⚡ GitHub 文件加速</h2>
<p class="text-gray-600 dark:text-gray-300 mb-4">输入 GitHub 文件链接，自动转换为加速链接。</p>
<div class="flex gap-2 mb-2">
<input id="github-url" type="text" placeholder="GitHub 文件链接" class="flex-grow p-2 border rounded-lg">
<button onclick="convertGithubUrl()" class="bg-blue-500 text-white px-4 py-2 rounded-lg">获取加速链接</button>
</div>
<p id="github-result" class="mt-2 text-green-600 dark:text-green-400 result-text hidden"></p>
<div id="github-buttons" class="flex gap-2 mt-2 github-buttons hidden">
<button onclick="copyGithubUrl()">📋 复制链接</button>
<button onclick="openGithubUrl()">🔗 打开链接</button>
</div>
</div>

<div class="section-box">
<h2 class="text-xl font-semibold mb-2">🐳 Docker 镜像加速</h2>
<p class="text-gray-600 dark:text-gray-300 mb-4">输入原镜像地址，获取加速拉取命令。</p>
<div class="flex gap-2 mb-2">
<input id="docker-image" type="text" placeholder="镜像地址" class="flex-grow p-2 border rounded-lg">
<button onclick="convertDockerImage()" class="bg-blue-500 text-white px-4 py-2 rounded-lg">获取加速命令</button>
</div>
<p id="docker-result" class="mt-2 text-green-600 dark:text-green-400 result-text hidden"></p>
<div id="docker-buttons" class="flex gap-2 mt-2 docker-buttons hidden">
<button onclick="copyDockerCommand()">📋 复制命令</button>
</div>
</div>
<footer class="mt-6 text-center text-gray-500 dark:text-gray-400">Powered by Cloudflare</footer>
</div>
<div id="toast" class="toast"></div>
<script>
const currentDomain=window.location.hostname;
let githubAcceleratedUrl=''; let dockerCommand='';
function toggleTheme(){const b=document.body;s=document.querySelector('.sun');m=document.querySelector('.moon');if(b.classList.contains('light-mode')){b.classList.replace('light-mode','dark-mode');localStorage.setItem('theme','dark');}else{b.classList.replace('dark-mode','light-mode');localStorage.setItem('theme','light');}}
if(localStorage.getItem('theme')==='dark'){toggleTheme();}
function showToast(msg,isErr=false){const t=document.getElementById('toast');t.textContent=msg;t.classList.add('show');setTimeout(()=>t.classList.remove('show'),3000);}
function copyToClipboard(text){if(navigator.clipboard&&window.isSecureContext){return navigator.clipboard.writeText(text);}const ta=document.createElement('textarea');ta.value=text;document.body.appendChild(ta);ta.focus();ta.select();try{return document.execCommand('copy')?Promise.resolve():Promise.reject()}finally{document.body.removeChild(ta);}}
function convertGithubUrl(){const input=document.getElementById('github-url').value.trim();const res=document.getElementById('github-result');const btns=document.getElementById('github-buttons');if(!input){showToast('请输入链接',true);res.classList.add('hidden');btns.classList.add('hidden');return;}githubAcceleratedUrl='https://'+currentDomain+'/https://'+input.substring(8);res.textContent='加速链接: '+githubAcceleratedUrl;res.classList.remove('hidden');btns.classList.remove('hidden');copyToClipboard(githubAcceleratedUrl).then(()=>showToast('已复制'));} 
function copyGithubUrl(){copyToClipboard(githubAcceleratedUrl).then(()=>showToast('已手动复制'));}
function openGithubUrl(){window.open(githubAcceleratedUrl,'_blank');}
function convertDockerImage(){const input=document.getElementById('docker-image').value.trim();const res=document.getElementById('docker-result');const btns=document.getElementById('docker-buttons');if(!input){showToast('请输入镜像',true);res.classList.add('hidden');btns.classList.add('hidden');return;}dockerCommand='docker pull '+currentDomain+'/'+input;res.textContent='加速命令: '+dockerCommand;res.classList.remove('hidden');btns.classList.remove('hidden');copyToClipboard(dockerCommand).then(()=>showToast('已复制'));} 
function copyDockerCommand(){copyToClipboard(dockerCommand).then(()=>showToast('已手动复制'));}
</script>
</body></html>`;

// 获取私有 token
function getPrivateToken(targetUrl, env) {
  const matched = TOKEN_MAPPING.find(cfg => targetUrl.startsWith(cfg.url));
  if (matched && env[matched.env_var]) return env[matched.env_var];
  return null;
}

function isAmazonS3(url) {
  try { return new URL(url).hostname.includes('amazonaws.com'); } catch { return false; }
}

function getEmptyBodySHA256() {
  return 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
}

async function handleToken(realm, service, scope, env, targetUrl) {
  const privateToken = getPrivateToken(targetUrl, env);
  if (privateToken) return privateToken;
  try {
    const resp = await fetch(`${realm}?service=${service}&scope=${scope}`, { headers: { Accept: 'application/json' } });
    const data = await resp.json();
    return data.token || data.access_token || null;
  } catch { return null; }
}

async function handleRequest(request, env) {
  const url = new URL(request.url);
  if(url.pathname==='/'||url.pathname==='') return new Response(HOMEPAGE_HTML,{status:200,headers:{'Content-Type':'text/html'}});
  let path=url.pathname.startsWith('/')?url.pathname.substring(1):url.pathname;
  let pathParts=path.split('/').filter(Boolean);
  let targetDomain,targetPath,isDockerRequest=false;
  if(path.startsWith('https://')||path.startsWith('http://')){
    const u=new URL(path);targetDomain=u.hostname;targetPath=u.pathname.substring(1)+u.search;
    isDockerRequest=['quay.io','gcr.io','k8s.gcr.io','registry.k8s.io','ghcr.io','docker.cloudsmith.io','registry-1.docker.io','docker.io'].includes(targetDomain);
    if(targetDomain==='docker.io') targetDomain='registry-1.docker.io';
  }else{
    if(pathParts[0]==='docker.io'){isDockerRequest=true;targetDomain='registry-1.docker.io';targetPath=pathParts.length===2?`library/${pathParts[1]}`:pathParts.slice(1).join('/');}
    else if(ALLOWED_HOSTS.includes(pathParts[0])){targetDomain=pathParts[0];targetPath=pathParts.slice(1).join('')+url.search;isDockerRequest=['quay.io','gcr.io','k8s.gcr.io','registry.k8s.io','ghcr.io','docker.cloudsmith.io','registry-1.docker.io'].includes(targetDomain);}
    else{isDockerRequest=true;targetDomain='registry-1.docker.io';targetPath=pathParts.join('/');}
  }
  if(!ALLOWED_HOSTS.includes(targetDomain)) return new Response('Invalid target domain\n',{status:400});
  if(RESTRICT_PATHS&&!ALLOWED_PATHS.some(p=>targetPath.toLowerCase().includes(p.toLowerCase()))) return new Response('Path not allowed\n',{status:403});
  let targetUrl=`https://${targetDomain}/${targetPath}`;
  const headers=new Headers(request.headers);headers.set('Host',targetDomain);headers.delete('x-amz-content-sha256');headers.delete('x-amz-date');headers.delete('x-amz-security-token');headers.delete('x-amz-user-agent');
  let response,redirects=0,currentUrl=targetUrl,MAX_REDIRECTS=5;
  while(redirects<=MAX_REDIRECTS){
    if(isAmazonS3(currentUrl)){headers.set('x-amz-content-sha256',getEmptyBodySHA256());headers.set('x-amz-date',new Date().toISOString().replace(/[-:T]/g,'').slice(0,-5)+'Z');}
    response=await fetch(currentUrl,{method:request.method,headers,body:request.body,redirect:'manual'});
    if(isDockerRequest&&response.status===401){
      const wwwAuth=response.headers.get('WWW-Authenticate');
      if(wwwAuth){const m=wwwAuth.match(/Bearer realm="([^"]+)",service="([^"]*)",scope="([^"]*)"/);if(m){const [,realm,service,scope]=m;const token=await handleToken(realm,service||targetDomain,scope,env,currentUrl);if(token) headers.set('Authorization',`Bearer ${token}`);response=await fetch(currentUrl,{method:request.method,headers,body:request.body,redirect:'manual'});}}}
    if((response.status===302||response.status===307)&&response.headers.get('Location')){currentUrl=response.headers.get('Location');redirects++;continue;}
    break;
  }
  const finalResponse=new Response(response.body,response);
  finalResponse.headers.set('Access-Control-Allow-Origin','*');
  finalResponse.headers.set('Access-Control-Allow-Methods','GET, HEAD, POST, OPTIONS');
  if(isDockerRequest) finalResponse.headers.set('Docker-Distribution-API-Version','registry/2.0');
  return finalResponse;
}

export default { async fetch(request, env, ctx){return handleRequest(request, env);} };
