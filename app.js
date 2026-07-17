const $=(s,p=document)=>p.querySelector(s),$$=(s,p=document)=>[...p.querySelectorAll(s)];
const stages=['立项','趋势验证','Demo MVP','小流量测试','规模转化'];
const stageColors=['#f0bd4d','#ff8b70','#4cc9c1','#5a9fdb','#786ae5'];
const ADMIN_EMAIL='luzw6688@gmail.com';
const config=window.APP_CONFIG||{};
const db=window.supabase?.createClient(config.supabaseUrl,config.supabasePublishableKey);
let state={projects:[],trends:[],activity:[]},deletedProjects=[],currentUser=null,isAdmin=false;
let selectedStage='all',selectedTrend='',searchTerm='',pendingProject='',pendingStage=null,toastTimer,realtimeChannel,reloadTimer;

function esc(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function today(){return new Date().toISOString().slice(0,10)}
function project(id){return state.projects.find(x=>x.id===id)}
function trendFor(projectId){return state.trends.find(x=>x.project===projectId)}
function setSync(text,mode=''){$('#syncState').textContent=text;$('#syncState').className=`sync-state ${mode}`.trim()}
function notice(text){const node=$('.toast');node.textContent=text;node.classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>node.classList.remove('show'),3000)}
function authMessage(text,type=''){$('#authMessage').textContent=text;$('#authMessage').className=`auth-message ${type}`.trim()}
function setBusy(form,busy){form.classList.toggle('saving-control',busy);$$('button,input,textarea,select',form).forEach(el=>el.disabled=busy)}
function requireAdmin(){if(isAdmin)return true;$('#authDialog').showModal();authMessage('请先使用管理员账号登录。');return false}

async function loadData({quiet=false}={}){
  if(!db){setSync('线上配置缺失','error');return}
  if(!quiet)setSync('正在同步…','saving');
  const [projectsRes,trendsRes,metricsRes,tasksRes,activityRes]=await Promise.all([
    db.from('projects').select('*').order('created_at',{ascending:false}),
    db.from('trends').select('*').order('created_at',{ascending:false}),
    db.from('metrics').select('*').order('position',{ascending:true}),
    db.from('tasks').select('*').order('created_at',{ascending:true}),
    db.from('activity_logs').select('*').order('created_at',{ascending:false}).limit(30)
  ]);
  const failure=[projectsRes,trendsRes,metricsRes,tasksRes,activityRes].find(r=>r.error);
  if(failure){setSync('同步失败','error');notice(`线上数据读取失败：${failure.error.message}`);return}
  deletedProjects=projectsRes.data.filter(p=>p.deleted_at);
  const activeRows=projectsRes.data.filter(p=>!p.deleted_at);
  state.projects=activeRows.map(p=>({
    ...p,next:p.next_action,
    metrics:metricsRes.data.filter(m=>m.project_id===p.id),
    tasks:tasksRes.data.filter(t=>t.project_id===p.id)
  }));
  state.trends=trendsRes.data.filter(t=>activeRows.some(p=>p.id===t.project_id)).map(t=>({...t,project:t.project_id}));
  state.activity=activityRes.data.map(a=>({...a,at:a.created_at.slice(0,10)}));
  renderAll();
  setSync(`已同步 · ${new Date().toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'})}`,'online');
}

async function writeLog(projectId,text,type='更新'){
  const {error}=await db.from('activity_logs').insert({project_id:projectId||null,text,type,actor_email:currentUser?.email||ADMIN_EMAIL});
  if(error)throw error;
}

async function mutate(action,successText){
  if(!requireAdmin())return false;
  setSync('正在保存…','saving');
  try{await action();await loadData({quiet:true});if(successText)notice(successText);return true}
  catch(error){setSync('保存失败','error');notice(`保存失败：${error.message||error}`);return false}
}

function renderAuth(){
  isAdmin=currentUser?.email?.toLowerCase()===ADMIN_EMAIL;
  $$('.admin-only').forEach(node=>node.hidden=!isAdmin);
  $('#authButton').textContent=isAdmin?'管理员 · 退出':'管理员登录';
  $('#sideUserInitial').textContent=isAdmin?'ML':'访';
  $('#sideUserName').childNodes[0].nodeValue=isAdmin?'曼斯菲尔德':'公开访客';
  $('#sideUserRole').textContent=isAdmin?'管理员':'只读查看';
  document.body.classList.toggle('is-admin',isAdmin);
}

function renderCounts(){
  const counts=stages.map((_,i)=>state.projects.filter(p=>p.stage===i).length);
  $('#activeProjects').textContent=String(state.projects.length).padStart(2,'0');
  $('#activeTrends').textContent=String(state.trends.length).padStart(2,'0');
  const waiting=state.trends.filter(t=>t.status.includes('等待')).length;
  const overdue=state.projects.filter(p=>p.tasks.some(t=>!t.done&&t.due<today())).length;
  $('#attentionCount').textContent=String(waiting+overdue).padStart(2,'0');
  $('#allCount').textContent=String(state.projects.length).padStart(2,'0');
  counts.forEach((n,i)=>{$(`#stage${i}Count`).textContent=String(n).padStart(2,'0')});
}

function filtered(){return state.projects.filter(p=>{const text=`${p.name} ${p.trend} ${p.owner}`.toLowerCase();return (selectedStage==='all'||p.stage===Number(selectedStage))&&(!selectedTrend||p.trend===selectedTrend)&&text.includes(searchTerm.toLowerCase())})}

function renderProjects(){
  const items=filtered();
  $('#projectRows').innerHTML=items.map(p=>`<article class="project-row" tabindex="0" data-project="${p.id}" role="row"><div class="project-name"><span class="project-dot" style="background:${stageColors[p.stage]}"></span><div><b>${esc(p.name)}</b><small>${esc(p.intro)}</small></div></div><div><span class="trend-chip"># ${esc(p.trend)}</span></div><div class="owner-cell">${esc(p.owner)}</div><div><span class="stage-pill" style="--stage:${stageColors[p.stage]}">${stages[p.stage]}</span><small class="cell-muted">${p.progress}% 已完成</small></div><div class="next-cell">${esc(p.next)}</div></article>`).join('');
  $('#emptyState').hidden=Boolean(items.length);
  const hasFilter=selectedStage!=='all'||selectedTrend||searchTerm;
  $('#emptyTitle').textContent=hasFilter?'未找到匹配的项目':'暂无进行中的项目';
  $('#emptyCopy').textContent=hasFilter?'尝试切换阶段，或清除当前筛选。':'管理员创建第一个项目后，所有访问者都能在这里看到最新进展。';
  const clues=[];if(selectedStage!=='all')clues.push(`「${stages[selectedStage]}」阶段`);if(selectedTrend)clues.push(`趋势「${selectedTrend}」`);if(searchTerm)clues.push(`搜索「${searchTerm}」`);
  $('#filterNote').textContent=clues.length?`当前显示 ${clues.join(' · ')}的 ${items.length} 个项目`:`当前显示全部 ${items.length} 个开发项目`;
}

function renderTrends(){
  $('#trendList').innerHTML=state.trends.length?state.trends.map(t=>{const p=project(t.project);return `<button class="trend-card ${selectedTrend===t.name?'selected':''}" data-trend="${t.id}"><div class="trend-card-top"><b># ${esc(t.name)}</b><span class="trend-score">${esc(t.growth)}</span></div><p>${esc(t.volume)} · 关联「${esc(p?.name||'待关联')}」</p><small>${esc(t.status)}</small></button>`}).join(''):'<p class="empty-inline">暂无趋势映射。管理员可以从第一个项目或内容链接开始建立验证关系。</p>';
}

function renderTrash(){
  $('#trashList').innerHTML=deletedProjects.length?deletedProjects.map(p=>`<div class="trash-item"><div><b>${esc(p.name)}</b><small>删除于 ${new Date(p.deleted_at).toLocaleString('zh-CN')}</small></div><button type="button" data-restore-project="${p.id}">恢复项目</button></div>`).join(''):'<p class="empty-inline">暂无已删除项目。</p>';
}

function renderAll(){
  renderCounts();renderProjects();renderTrends();renderTrash();renderAuth();
  $('#trendProject').innerHTML=`<option value="">选择关联项目</option>${state.projects.map(p=>`<option value="${p.id}">${esc(p.name)}</option>`).join('')}`;
}

function metricCard(m,p){return `<div class="metric-data"><div><span>${esc(m.name)}</span><b>${esc(m.value)}</b><small>来源：${esc(m.source)}</small></div>${isAdmin?`<button data-edit-metric="${m.id}" data-project="${p.id}">维护</button>`:''}</div>`}
function taskRow(t,p){return `<label class="task-row"><input type="checkbox" data-task="${t.id}" data-project="${p.id}" ${t.done?'checked':''} ${isAdmin?'':'disabled'}><span><b>${esc(t.title)}</b><small>${esc(t.owner)} · 截止 ${esc(t.due)} · ${esc(t.criteria)}</small></span></label>`}

function openDrawer(p){
  if(!p)return;
  const t=trendFor(p.id);
  const stageButtons=stages.map((name,i)=>`<button class="${i===p.stage?'active':''}" data-stage-select="${i}" data-project="${p.id}" ${isAdmin?'':'disabled'}>${i+1}. ${name}</button>`).join('');
  $('#drawerEyebrow').textContent=`项目详情 · ${stages[p.stage]}`;$('#drawerTitle').textContent=p.name;
  $('#drawerContent').innerHTML=`<section class="drawer-block"><div class="drawer-section-head"><h3>项目介绍</h3>${isAdmin?`<button data-edit-project="${p.id}">编辑资料</button>`:''}</div><p>${esc(p.intro)}</p></section><section class="drawer-block"><h3>趋势来源与假设</h3><p class="team-line"><b>验证趋势</b># ${esc(p.trend)}</p>${t?`<p class="data-source">来源：<a href="${esc(t.url)}" target="_blank" rel="noreferrer">${esc(t.volume)}，${esc(t.growth)} ↗</a></p><p class="data-hypothesis">验证假设：${esc(t.hypothesis)}</p>`:'<p class="data-hypothesis">尚未建立趋势映射</p>'}<p class="team-line"><b>负责人</b>${esc(p.owner)}</p><p class="team-line"><b>参与人员</b>${esc(p.members)}</p></section><section class="drawer-block"><div class="drawer-section-head"><h3>验证指标</h3>${isAdmin?`<button data-add-metric="${p.id}">＋ 添加</button>`:''}</div><div class="metric-data-list">${p.metrics.length?p.metrics.map(m=>metricCard(m,p)).join(''):'<p class="empty-inline">尚未录入验证指标。</p>'}</div></section><section class="drawer-block"><h3>项目流转</h3><div class="stage-controls">${stageButtons}</div>${isAdmin?`<button class="primary-btn advance-btn" data-advance="${p.id}" ${p.stage===4?'disabled':''}>${p.stage===4?'已进入规模转化':'申请推进至下一阶段 →'}</button>`:'<p class="readonly-note">当前为公开只读模式，只有管理员可以调整阶段。</p>'}</section><section class="drawer-block"><div class="drawer-section-head"><h3>下一步任务</h3>${isAdmin?`<button data-add-task="${p.id}">＋ 添加</button>`:''}</div><p class="next-summary">${esc(p.next)}</p><div class="task-list">${p.tasks.length?p.tasks.map(t=>taskRow(t,p)).join(''):'<p class="empty-inline">尚未添加任务。</p>'}</div></section><section class="drawer-block"><h3>最近记录</h3><div class="activity-list">${state.activity.filter(a=>a.project_id===p.id||a.text.includes(p.name)).slice(0,5).map(a=>`<p>${esc(a.at)} · ${esc(a.text)}</p>`).join('')||'<p>项目后续操作会记录在这里。</p>'}</div></section>${isAdmin?`<div class="drawer-actions"><button class="danger-btn" data-delete-project="${p.id}">删除项目</button></div>`:''}`;
  $('#detailDrawer').classList.add('open');$('#drawerOverlay').classList.add('open');$('#detailDrawer').setAttribute('aria-hidden','false');
}

function closeDrawer(){$('#detailDrawer').classList.remove('open');$('#drawerOverlay').classList.remove('open');$('#detailDrawer').setAttribute('aria-hidden','true')}
function setStage(stage){selectedStage=stage;$$('.stage-tab').forEach(tab=>tab.classList.toggle('active',tab.dataset.stage===String(stage)));renderProjects()}
function requestStage(projectId,target){if(!requireAdmin())return;const p=project(projectId);if(!p||target===p.stage)return;pendingProject=projectId;pendingStage=target;$('#advanceTitle').textContent=`确认调整至「${stages[target]}」？`;$('#advanceCopy').textContent=`「${p.name}」将从「${stages[p.stage]}」调整为「${stages[target]}」。系统会保留本次变更记录。`;$('#advanceCheck').checked=false;$('#advanceDialog').showModal()}

function ensureSignalOption(value){const select=$('#newProjectSignal');if(value&&![...select.options].some(o=>o.value===value)){const option=document.createElement('option');option.value=value;option.textContent=value;select.append(option)}select.value=value||''}
function openNewProject(){if(!requireAdmin())return;$('#projectForm').reset();$('#editProjectId').value='';$('#projectDialogTitle').textContent='创建新的增长项目';$('#projectSubmit').textContent='创建并进入立项 →';$('#trendLinkField').classList.remove('visible');$('#projectDialog').showModal()}
function openEditProject(p){if(!requireAdmin())return;const t=trendFor(p.id);$('#editProjectId').value=p.id;$('#newProjectName').value=p.name;$('#newProjectIntro').value=p.intro;ensureSignalOption(p.trend);$('#trendLink').value=t?.url||'';$('#projectOwner').value=p.owner;$('#projectMembers').value=p.members;$('#trendLinkField').classList.add('visible');$('#trendLink').required=true;$('#projectDialogTitle').textContent='编辑项目资料';$('#projectSubmit').textContent='保存项目资料 →';$('#projectDialog').showModal()}
function openMetric(projectId,metricId=''){if(!requireAdmin())return;const p=project(projectId),m=metricId?p.metrics.find(x=>x.id===metricId):{name:'',value:'',source:'',note:''};$('#metricDialogTitle').textContent=metricId?'维护验证指标':'添加验证指标';$('#metricProjectId').value=projectId;$('#metricIndex').value=metricId;$('#metricName').value=m.name;$('#metricValue').value=m.value;$('#metricSource').value=m.source;$('#metricNote').value=m.note||'';$('#metricDialog').showModal()}
function openTask(projectId){if(!requireAdmin())return;$('#taskForm').reset();$('#taskProjectId').value=projectId;$('#taskDue').value=today();$('#taskDialog').showModal()}
function showDataGuide(){const list=state.activity.slice(0,8).map(a=>`<p><b>${esc(a.at)}</b><span>${esc(a.type)} · ${esc(a.text)}</span></p>`).join('');$('#dataLog').innerHTML=`<h3>最近线上记录</h3>${list||'<p>暂无记录</p>'}`;renderTrash();$('#dataDialog').showModal()}

$('#addProject').addEventListener('click',openNewProject);$('#emptyAddProject').addEventListener('click',openNewProject);$('#dataGuide').addEventListener('click',showDataGuide);$('#modelExplain').addEventListener('click',()=>$('#modelDialog').showModal());$('#modelExplainSecondary').addEventListener('click',()=>$('#modelDialog').showModal());
$('#authButton').addEventListener('click',async()=>{if(isAdmin){await db.auth.signOut();notice('已退出管理员账号。')}else{$('#authPassword').value='';authMessage('');$('#authDialog').showModal()}});
$('#newProjectSignal').addEventListener('change',e=>{const show=Boolean(e.target.value);$('#trendLinkField').classList.toggle('visible',show);$('#trendLink').required=show});
$$('.dialog-close,.cancel-dialog').forEach(b=>b.addEventListener('click',()=>b.closest('dialog').close()));

$('#authForm').addEventListener('submit',async e=>{e.preventDefault();const form=e.currentTarget,password=$('#authPassword').value;setBusy(form,true);authMessage('正在验证…');const {data,error}=await db.auth.signInWithPassword({email:ADMIN_EMAIL,password});setBusy(form,false);if(error){authMessage(error.message,'error');return}currentUser=data.user;renderAuth();$('#authDialog').close();notice('管理员登录成功。')});
$('#projectForm').addEventListener('submit',async e=>{e.preventDefault();const form=e.currentTarget,id=$('#editProjectId').value,name=$('#newProjectName').value.trim(),intro=$('#newProjectIntro').value.trim(),trend=$('#newProjectSignal').value,link=$('#trendLink').value.trim(),owner=$('#projectOwner').value.trim(),members=$('#projectMembers').value.trim();if(!name||!intro||!trend||!link||!owner||!members)return;setBusy(form,true);const ok=await mutate(async()=>{if(id){const {error}=await db.from('projects').update({name,intro,trend,owner,members}).eq('id',id);if(error)throw error;const existing=trendFor(id);if(existing){const {error:trendError}=await db.from('trends').update({name,url:link}).eq('id',existing.id);if(trendError)throw trendError}else{const {error:trendError}=await db.from('trends').insert({project_id:id,name,url:link});if(trendError)throw trendError}await writeLog(id,`更新项目「${name}」的资料`,'项目编辑')}else{const {data:p,error}=await db.from('projects').insert({name,intro,trend,owner,members}).select().single();if(error)throw error;const {error:trendError}=await db.from('trends').insert({project_id:p.id,name:trend,url:link});if(trendError)throw trendError;await writeLog(p.id,`创建项目「${name}」并建立趋势来源`,'新增')}} ,id?'项目资料已保存。':`「${name}」已立项。`);setBusy(form,false);if(ok){$('#projectDialog').close();form.reset();$('#trendLinkField').classList.remove('visible');setStage(id?selectedStage:'0');const saved=id?project(id):state.projects.find(p=>p.name===name);if(saved)openDrawer(saved)}});

$('#openTrendMap').addEventListener('click',()=>{if(requireAdmin())$('#trendDialog').showModal()});
$('#trendForm').addEventListener('submit',async e=>{e.preventDefault();const form=e.currentTarget,name=$('#trendName').value.trim(),url=$('#trendUrl').value.trim(),projectId=$('#trendProject').value,hypothesis=$('#trendHypothesis').value.trim(),p=project(projectId);if(!name||!url||!p||!hypothesis)return;setBusy(form,true);const ok=await mutate(async()=>{const {error}=await db.from('trends').insert({project_id:projectId,name,url,hypothesis});if(error)throw error;const {error:projectError}=await db.from('projects').update({trend:name}).eq('id',projectId);if(projectError)throw projectError;await writeLog(projectId,`将趋势「${name}」关联到项目「${p.name}」`,'趋势映射')},`趋势已关联到「${p.name}」。`);setBusy(form,false);if(ok){$('#trendDialog').close();form.reset();selectedTrend=name;renderAll()}});

$('#stageTabs').addEventListener('click',e=>{const tab=e.target.closest('.stage-tab');if(tab)setStage(tab.dataset.stage)});$('#projectSearch').addEventListener('input',e=>{searchTerm=e.target.value.trim();renderProjects()});$('#clearFilter').addEventListener('click',()=>{selectedTrend='';searchTerm='';$('#projectSearch').value='';setStage('all');renderTrends()});$('#projectRows').addEventListener('click',e=>{const row=e.target.closest('.project-row');if(row)openDrawer(project(row.dataset.project))});$('#projectRows').addEventListener('keydown',e=>{if(e.key==='Enter'){const row=e.target.closest('.project-row');if(row)openDrawer(project(row.dataset.project))}});
$('#trendList').addEventListener('click',e=>{const card=e.target.closest('.trend-card');if(!card)return;const t=state.trends.find(x=>x.id===card.dataset.trend);selectedTrend=selectedTrend===t.name?'':t.name;setStage('all');renderTrends();notice(selectedTrend?`已筛选关联「${t.name}」的项目。`:'已显示全部项目。')});$('#resetTrend').addEventListener('click',()=>{selectedTrend='';renderProjects();renderTrends()});$('#drawerClose').addEventListener('click',closeDrawer);$('#drawerOverlay').addEventListener('click',closeDrawer);

$('#drawerContent').addEventListener('click',async e=>{const stage=e.target.dataset.stageSelect,projectId=e.target.dataset.project;if(stage!==undefined)requestStage(projectId,Number(stage));if(e.target.dataset.advance){const p=project(e.target.dataset.advance);requestStage(p.id,Math.min(p.stage+1,4))}if(e.target.dataset.addMetric)openMetric(e.target.dataset.addMetric);if(e.target.dataset.editMetric)openMetric(e.target.dataset.project,e.target.dataset.editMetric);if(e.target.dataset.addTask)openTask(e.target.dataset.addTask);if(e.target.dataset.editProject)openEditProject(project(e.target.dataset.editProject));if(e.target.dataset.deleteProject){const p=project(e.target.dataset.deleteProject);if(!confirm(`确认删除项目「${p.name}」？删除后可在“数据口径”中恢复。`))return;const ok=await mutate(async()=>{const {error}=await db.from('projects').update({deleted_at:new Date().toISOString()}).eq('id',p.id);if(error)throw error;await writeLog(p.id,`删除项目「${p.name}」`,'删除')},'项目已移入已删除列表。');if(ok)closeDrawer()}});
$('#drawerContent').addEventListener('change',async e=>{if(!e.target.dataset.task||!isAdmin)return;const p=project(e.target.dataset.project),task=p.tasks.find(t=>t.id===e.target.dataset.task),done=e.target.checked;const ok=await mutate(async()=>{const {error}=await db.from('tasks').update({done}).eq('id',task.id);if(error)throw error;await writeLog(p.id,`${done?'完成':'重新打开'}任务「${task.title}」`,'任务')},done?'任务已完成。':'任务已重新打开。');if(ok)openDrawer(project(p.id))});

$('#advanceForm').addEventListener('submit',async e=>{e.preventDefault();if(!pendingProject||pendingStage===null||!$('#advanceCheck').checked)return;const form=e.currentTarget,p=project(pendingProject),from=stages[p.stage],target=pendingStage;setBusy(form,true);const ok=await mutate(async()=>{const {error}=await db.from('projects').update({stage:target,progress:Math.min(100,p.progress+14)}).eq('id',p.id);if(error)throw error;await writeLog(p.id,`项目「${p.name}」从「${from}」调整至「${stages[target]}」`,'阶段流转')},`已更新为「${stages[target]}」。`);setBusy(form,false);if(ok){$('#advanceDialog').close();openDrawer(project(p.id));pendingProject='';pendingStage=null}});

$('#metricForm').addEventListener('submit',async e=>{e.preventDefault();const form=e.currentTarget,p=project($('#metricProjectId').value),metricId=$('#metricIndex').value,m={project_id:p.id,name:$('#metricName').value.trim(),value:$('#metricValue').value.trim(),source:$('#metricSource').value.trim(),note:$('#metricNote').value.trim()};if(!m.name||!m.value||!m.source)return;setBusy(form,true);const ok=await mutate(async()=>{const query=metricId?db.from('metrics').update(m).eq('id',metricId):db.from('metrics').insert(m);const {error}=await query;if(error)throw error;await writeLog(p.id,`${metricId?'更新':'添加'}项目「${p.name}」的指标「${m.name}」`,'指标')},'指标与数据来源已保存。');setBusy(form,false);if(ok){$('#metricDialog').close();openDrawer(project(p.id))}});

$('#taskForm').addEventListener('submit',async e=>{e.preventDefault();const form=e.currentTarget,p=project($('#taskProjectId').value),task={project_id:p.id,title:$('#taskTitle').value.trim(),owner:$('#taskOwner').value.trim(),due:$('#taskDue').value,criteria:$('#taskDone').value.trim()};if(!task.title||!task.owner||!task.due||!task.criteria)return;setBusy(form,true);const ok=await mutate(async()=>{const {error}=await db.from('tasks').insert(task);if(error)throw error;const {error:projectError}=await db.from('projects').update({next_action:task.title}).eq('id',p.id);if(projectError)throw projectError;await writeLog(p.id,`为项目「${p.name}」添加任务「${task.title}」`,'任务')},'任务已添加，并成为当前下一步。');setBusy(form,false);if(ok){$('#taskDialog').close();openDrawer(project(p.id))}});

$('#trashList').addEventListener('click',async e=>{const id=e.target.dataset.restoreProject;if(!id||!requireAdmin())return;const p=deletedProjects.find(x=>x.id===id);const ok=await mutate(async()=>{const {error}=await db.from('projects').update({deleted_at:null}).eq('id',id);if(error)throw error;await writeLog(id,`恢复项目「${p.name}」`,'恢复')},`「${p.name}」已恢复。`);if(ok){renderTrash();showDataGuide()}});
$('#exportData').addEventListener('click',()=>{if(!requireAdmin())return;const payload=JSON.stringify({exportedAt:new Date().toISOString(),projects:state.projects,trends:state.trends,activity:state.activity,deletedProjects},null,2),blob=new Blob([payload],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=`company-project-board-${today()}.json`;a.click();URL.revokeObjectURL(url);notice('JSON 备份已导出。')});
document.addEventListener('keydown',e=>{if(e.key==='Escape')closeDrawer()});

async function initialize(){
  if(!db){setSync('线上配置缺失','error');renderAll();return}
  const {data}=await db.auth.getSession();currentUser=data.session?.user||null;renderAuth();
  db.auth.onAuthStateChange((_event,session)=>{currentUser=session?.user||null;renderAuth()});
  await loadData();
  realtimeChannel=db.channel('company-project-board-live').on('postgres_changes',{event:'*',schema:'public'},()=>{clearTimeout(reloadTimer);reloadTimer=setTimeout(()=>loadData({quiet:true}),350)}).subscribe(status=>{if(status==='CHANNEL_ERROR')setSync('实时连接中断','error')});
}

initialize();
