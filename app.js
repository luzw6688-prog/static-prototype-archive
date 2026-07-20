const $=(s,p=document)=>p.querySelector(s),$$=(s,p=document)=>[...p.querySelectorAll(s)];
const stages=['立项','趋势验证','Demo MVP','小流量测试','规模转化'];
const stageColors=['#f0bd4d','#ff8b70','#4cc9c1','#5a9fdb','#786ae5'];
const experimentMethods=['内容测试','用户访谈 / 问卷','可用性测试','Demo 测试','小流量投放','A/B 测试','数据分析','其他'];
const experimentDecisions=['继续验证','进入下一阶段','调整方向','暂停','终止','规模化'];
const appCategories={
  '工具与效率':['待办与日历','笔记与文档','AI 助手','扫描与识别','文件管理','浏览器与搜索','翻译工具','计算与换算','设备工具','开发者工具'],
  '社交与社区':['即时通讯','兴趣社区','熟人社交','陌生人社交','婚恋交友','职场人脉','语音社交','视频社交','家庭社交','本地社交'],
  '健康与身心':['运动健身','饮食营养','睡眠管理','冥想减压','心理健康','女性健康','慢病管理','医疗问诊','用药管理','健康数据'],
  '生活方式':['星座与玄学','美妆与穿搭','家居与家装','母婴与育儿','宠物服务','情感关系','兴趣爱好','习惯养成','本地生活','天气服务'],
  '内容与娱乐':['短视频','长视频与流媒体','音乐与音频','直播','阅读与小说','漫画','新闻资讯','图片与视频创作','票务与演出','游戏与互动娱乐'],
  '教育与成长':['语言学习','K12 教育','高等教育','职业技能','考试与认证','知识付费','儿童启蒙','阅读学习','编程教育','AI 学习'],
  '商业与金融':['移动支付','银行服务','投资理财','保险服务','记账与预算','电商购物','二手交易','企业协作','CRM 与营销','求职与招聘'],
  '出行与本地服务':['地图与导航','打车与租车','公共交通','旅行预订','攻略与导览','酒店与民宿','航班与铁路','汽车服务','餐饮与外卖','到店服务']
};
const ADMIN_EMAIL='luzw6688@gmail.com';
const config=window.APP_CONFIG||{};
const db=window.supabase?.createClient(config.supabaseUrl,config.supabasePublishableKey);
let state={projects:[],trends:[],activity:[],gateDefinitions:[]},deletedProjects=[],currentUser=null,isAdmin=false;
let selectedStage='all',selectedTrend='',selectedCommandFilter='',searchTerm='',pendingProject='',pendingStage=null,pendingStageMode='advance',toastTimer,realtimeChannel,reloadTimer;

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
  const [projectsRes,trendsRes,metricsRes,tasksRes,activityRes,gateDefinitionsRes,gatesRes,historyRes,experimentsRes]=await Promise.all([
    db.from('projects').select('*').order('created_at',{ascending:false}),
    db.from('trends').select('*').order('created_at',{ascending:false}),
    db.from('metrics').select('*').order('position',{ascending:true}),
    db.from('tasks').select('*').order('created_at',{ascending:true}),
    db.from('activity_logs').select('*').order('created_at',{ascending:false}).limit(1000),
    db.from('stage_gate_definitions').select('*').order('stage',{ascending:true}).order('position',{ascending:true}),
    db.from('project_stage_gates').select('*').order('created_at',{ascending:true}),
    db.from('stage_history').select('*').order('created_at',{ascending:false}).limit(1000),
    db.from('validation_experiments').select('*').order('created_at',{ascending:false}).limit(1000)
  ]);
  const failure=[projectsRes,trendsRes,metricsRes,tasksRes,activityRes,gateDefinitionsRes,gatesRes,historyRes,experimentsRes].find(r=>r.error);
  if(failure){setSync('同步失败','error');notice(`线上数据读取失败：${failure.error.message}`);return}
  deletedProjects=projectsRes.data.filter(p=>p.deleted_at);
  const activeRows=projectsRes.data.filter(p=>!p.deleted_at);
  state.projects=activeRows.map(p=>({
    ...p,next:p.next_action,
    metrics:metricsRes.data.filter(m=>m.project_id===p.id),
    tasks:tasksRes.data.filter(t=>t.project_id===p.id),
    gates:gatesRes.data.filter(g=>g.project_id===p.id),
    history:historyRes.data.filter(h=>h.project_id===p.id),
    experiments:experimentsRes.data.filter(e=>e.project_id===p.id).sort((a,b)=>b.round_no-a.round_no)
  }));
  state.trends=trendsRes.data.filter(t=>activeRows.some(p=>p.id===t.project_id)).map(t=>({...t,project:t.project_id}));
  state.activity=activityRes.data.map(a=>({...a,at:a.created_at.slice(0,10)}));
  state.gateDefinitions=gateDefinitionsRes.data;
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
  const stats=decisionStats();
  const values={activeProjects:stats.active.current,weeklyConclusions:stats.conclusions.current,pendingDecisions:stats.pending.current,riskProjects:stats.risk.current,scaleCandidates:stats.scale.current};
  Object.entries(values).forEach(([id,value])=>{$(`#${id}`).textContent=String(value).padStart(2,'0')});
  [['activeProjectsDelta',stats.active],['weeklyConclusionsDelta',stats.conclusions],['pendingDecisionsDelta',stats.pending],['riskProjectsDelta',stats.risk],['scaleCandidatesDelta',stats.scale]].forEach(([id,data])=>renderDelta(id,data.current-data.previous));
  $('#decisionWeekRange').textContent=`${formatShortDate(stats.weekStart)} — ${formatShortDate(stats.weekEnd)} · 数据实时更新`;
  $$('[data-command-filter]').forEach(card=>{const active=selectedCommandFilter===card.dataset.commandFilter,alert=Number(card.querySelector('strong').textContent)>0;card.classList.toggle('active',active);card.classList.toggle('has-alert',alert);card.setAttribute('aria-pressed',String(active))});
  renderStageFunnel();
}

function stageEnteredAt(p){
  const history=p.history?.find(h=>h.to_stage===p.stage);
  if(history){const value=new Date(history.created_at);if(Number.isFinite(value.getTime()))return value}
  const marker=`调整至「${stages[p.stage]}」`;
  const entry=state.activity.find(a=>a.project_id===p.id&&a.type==='阶段流转'&&a.text.includes(marker));
  const value=new Date(entry?.created_at||p.created_at);
  return Number.isFinite(value.getTime())?value:new Date();
}
function gateDefinitions(stage){return state.gateDefinitions.filter(g=>g.stage===stage)}
function gateStatus(p,stage=p.stage){const definitions=gateDefinitions(stage),completed=new Set(p.gates.filter(g=>g.stage===stage&&g.completed).map(g=>g.gate_key)),missing=definitions.filter(g=>g.required&&!completed.has(g.gate_key));return {definitions,completed,missing,done:definitions.filter(g=>completed.has(g.gate_key)).length,total:definitions.length}}
function experimentComplete(e){return Boolean(e.completed_at&&e.conclusion?.trim()&&e.decision)}
function hasCompletedStageExperiment(p,stage=p.stage){return p.experiments.some(e=>e.stage===stage&&experimentComplete(e))}
function advanceRequirements(p){const missing=gateStatus(p).missing.map(g=>({type:'gate',label:g.label}));if(p.stage<4&&!hasCompletedStageExperiment(p))missing.push({type:'experiment',label:`完成至少一轮「${stages[p.stage]}」验证实验，并填写结论与最终决策`});return missing}
function stageFunnelStats(){
  const total=state.projects.length,now=Date.now();
  return stages.map((_,stage)=>{const projects=state.projects.filter(p=>p.stage===stage),dwell=projects.map(p=>Math.max(0,(now-stageEnteredAt(p).getTime())/86400000));return {count:projects.length,share:total?Math.round(projects.length/total*100):0,average:dwell.length?dwell.reduce((sum,n)=>sum+n,0)/dwell.length:0,overdue:projects.filter(p=>p.tasks.some(t=>!t.done&&t.due<today())).length}});
}
function renderStageFunnel(){
  const stats=stageFunnelStats();
  $('#allCount').textContent=String(state.projects.length).padStart(2,'0');
  stats.forEach((item,i)=>{$(`#stage${i}Count`).textContent=String(item.count).padStart(2,'0');$(`#stage${i}Share`).textContent=`${item.share}%`;$(`#stage${i}Dwell`).textContent=`${item.average.toFixed(1)} 天`;$(`#stage${i}Overdue`).textContent=String(item.overdue);$(`#stage${i}Bar`).style.width=`${item.share}%`;const tab=$(`.stage-tab[data-stage="${i}"]`);tab.classList.toggle('has-overdue',item.overdue>0)});
}

function startOfWeek(date=new Date()){const value=new Date(date);value.setHours(0,0,0,0);value.setDate(value.getDate()-((value.getDay()+6)%7));return value}
function endOfWeek(start){const value=new Date(start);value.setDate(value.getDate()+7);return value}
function inRange(value,start,end){const time=new Date(value).getTime();return Number.isFinite(time)&&time>=start.getTime()&&time<end.getTime()}
function formatShortDate(date){return date.toLocaleDateString('zh-CN',{month:'numeric',day:'numeric'})}
function renderDelta(id,delta){const node=$(`#${id}`);node.textContent=delta===0?'与上周持平':`较上周 ${delta>0?'+':''}${delta}`;node.classList.toggle('is-up',delta>0);node.classList.toggle('is-down',delta<0)}
function conclusionLogs(start,end){return state.activity.filter(a=>['指标','阶段流转','趋势结论','阶段结论','验证结论'].includes(a.type)&&inRange(a.created_at,start,end))}
function isPendingConclusion(a){return ['指标','趋势结论','阶段结论'].includes(a.type)||(a.type==='验证结论'&&/(进入下一阶段|规模化)/.test(a.text))}
function pendingDecisionIds(end=new Date()){return new Set(state.projects.filter(p=>{const logs=state.activity.filter(a=>a.project_id===p.id&&new Date(a.created_at)<end);const conclusion=logs.find(isPendingConclusion);const decision=logs.find(a=>a.type==='阶段流转');return conclusion&&(!decision||new Date(conclusion.created_at)>new Date(decision.created_at))}).map(p=>p.id))}
function riskProjectIds(cutoff=today()){return new Set(state.projects.filter(p=>p.tasks.some(t=>!t.done&&t.due<cutoff)||state.trends.some(t=>t.project===p.id&&/(风险|阻塞|异常|逾期)/.test(t.status||''))).map(p=>p.id))}
function decisionStats(){
  const weekStart=startOfWeek(),weekEnd=endOfWeek(weekStart),previousStart=new Date(weekStart);previousStart.setDate(previousStart.getDate()-7);
  const pendingNow=pendingDecisionIds(),pendingPrevious=pendingDecisionIds(weekStart),riskNow=riskProjectIds(),riskPrevious=riskProjectIds(weekStart.toISOString().slice(0,10));
  const enteredScaleThisWeek=new Set(conclusionLogs(weekStart,weekEnd).filter(a=>a.type==='阶段流转'&&a.text.includes('规模转化')).map(a=>a.project_id));
  return {weekStart,weekEnd:new Date(weekEnd.getTime()-86400000),pendingIds:pendingNow,riskIds:riskNow,
    active:{current:state.projects.length,previous:state.projects.filter(p=>new Date(p.created_at)<weekStart).length},
    conclusions:{current:conclusionLogs(weekStart,weekEnd).length,previous:conclusionLogs(previousStart,weekStart).length},
    pending:{current:pendingNow.size,previous:pendingPrevious.size},
    risk:{current:riskNow.size,previous:riskPrevious.size},
    scale:{current:state.projects.filter(p=>p.stage===4).length,previous:state.projects.filter(p=>p.stage===4&&!enteredScaleThisWeek.has(p.id)).length}};
}

function filtered(){const stats=decisionStats();return state.projects.filter(p=>{const text=`${p.name} ${p.category} ${p.subcategory} ${p.trend} ${p.owner}`.toLowerCase();const commandMatch=!selectedCommandFilter||(selectedCommandFilter==='decision'?stats.pendingIds:stats.riskIds).has(p.id);return commandMatch&&(selectedStage==='all'||p.stage===Number(selectedStage))&&(!selectedTrend||p.trend===selectedTrend)&&text.includes(searchTerm.toLowerCase())})}

function renderProjects(){
  const items=filtered();
  $('#projectRows').innerHTML=items.map(p=>`<article class="project-row" tabindex="0" data-project="${p.id}" role="row"><div class="project-name"><span class="project-dot" style="background:${stageColors[p.stage]}"></span><div><b>${esc(p.name)}</b><small>${esc(p.intro)}</small></div></div><div class="category-cell"><span class="category-chip">${esc(p.category||'未分类')}</span><small>${esc(p.subcategory||'待补充')}</small></div><div class="owner-cell">${esc(p.owner)}</div><div><span class="stage-pill" style="--stage:${stageColors[p.stage]}">${stages[p.stage]}</span><small class="cell-muted">${p.progress}% 已完成</small></div><div class="next-cell">${esc(p.next)}</div></article>`).join('');
  $('#emptyState').hidden=Boolean(items.length);
  const hasFilter=selectedStage!=='all'||selectedTrend||selectedCommandFilter||searchTerm;
  $('#emptyTitle').textContent=hasFilter?'未找到匹配的项目':'暂无进行中的项目';
  $('#emptyCopy').textContent=hasFilter?'尝试切换阶段，或清除当前筛选。':'管理员创建第一个项目后，所有访问者都能在这里看到最新进展。';
  const clues=[];if(selectedCommandFilter)clues.push(selectedCommandFilter==='decision'?'「待决策项目」':'「风险与逾期」');if(selectedStage!=='all')clues.push(`「${stages[selectedStage]}」阶段`);if(selectedTrend)clues.push(`趋势「${selectedTrend}」`);if(searchTerm)clues.push(`搜索「${searchTerm}」`);
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
function thresholdLabel(e){return `${e.threshold_operator} ${Number(e.threshold_value).toLocaleString('zh-CN')} ${esc(e.threshold_unit)}`}
function sourceMarkup(value){const text=esc(value);return /^https?:\/\//i.test(value)?`<a href="${text}" target="_blank" rel="noreferrer">查看数据来源 ↗</a>`:text}
function experimentTimeline(p){return p.experiments.length?p.experiments.map(e=>{const complete=experimentComplete(e),result=e.threshold_met===true?'达标':e.threshold_met===false?'未达标':'待结果',tone=e.threshold_met===true?'passed':e.threshold_met===false?'failed':'';return `<article class="experiment-card ${complete?'completed':'validating'}"><span class="experiment-node"></span><div class="experiment-card-head"><div><span>ROUND ${String(e.round_no).padStart(2,'0')} · ${esc(stages[e.stage])}</span><b>${esc(e.hypothesis)}</b></div><em class="experiment-status ${complete?'done':''}">${complete?'已完成':'验证中'}</em></div><div class="experiment-meta"><span><i>目标用户</i>${esc(e.target_user)}</span><span><i>验证方式</i>${esc(e.method)}</span><span><i>成功阈值</i>${thresholdLabel(e)}</span><span><i>周期</i>${esc(e.start_date)} — ${esc(e.end_date)}</span></div>${complete?`<div class="experiment-result"><div><span class="result-chip ${tone}">${result}</span><b>${Number(e.actual_value).toLocaleString('zh-CN')} ${esc(e.threshold_unit)}</b><small>${esc(e.actual_data)}</small></div><p><i>数据来源</i>${sourceMarkup(e.data_source)}</p><p><i>验证结论</i>${esc(e.conclusion)}</p><p><i>最终决策</i><strong>${esc(e.decision)}</strong></p><p class="learning"><i>关键学习</i>${esc(e.key_learning)}</p></div>`:`<p class="experiment-waiting">实验进行中，结束后填写实际数据、验证结论与最终决策。</p>`}${isAdmin?`<button class="experiment-result-btn" data-experiment-result="${e.id}" data-project="${p.id}">${complete?'维护实验结果':'填写实验结果'} →</button>`:''}</article>`}).join(''):'<p class="empty-inline experiment-empty">暂无验证实验。先把假设、用户、方式和成功阈值写清楚，再开始验证。</p>'}
function gateChecklist(p){const status=gateStatus(p),missing=advanceRequirements(p);return `<div class="gate-summary"><div><span>${esc(stages[p.stage])}完成度</span><b>${status.done} / ${status.total}</b></div><div class="gate-progress"><i style="width:${status.total?Math.round(status.done/status.total*100):0}%"></i></div></div><div class="gate-list">${status.definitions.map(g=>`<label class="gate-item ${status.completed.has(g.gate_key)?'completed':''}"><input type="checkbox" data-gate="${esc(g.gate_key)}" data-stage="${g.stage}" data-project="${p.id}" ${status.completed.has(g.gate_key)?'checked':''} ${isAdmin?'':'disabled'}><span><b>${esc(g.label)}</b><small>${g.required?'必填门槛':'建议门槛'}</small></span></label>`).join('')}</div>${missing.length?`<div class="gate-blocker"><b>暂不能推进，还缺少 ${missing.length} 项</b><ul>${missing.map(item=>`<li class="${item.type==='experiment'?'experiment-required':''}">${esc(item.label)}</li>`).join('')}</ul></div>`:'<div class="gate-ready"><b>当前阶段门槛与验证实验已完成</b><span>可以申请推进至相邻的下一阶段。</span></div>'}`}
function stageTimeline(p){return p.history?.length?p.history.map(h=>{const initial=h.from_stage===null,from=initial?'项目创建':stages[h.from_stage],to=stages[h.to_stage],kind={initial:'创建',advance:'推进',rollback:'回退',cross_stage:'跨阶段'}[h.change_type]||'调整';return `<div class="timeline-item ${h.change_type}"><span class="timeline-dot"></span><div><div class="timeline-top"><b>${esc(kind)} · ${esc(from)}${initial?'':' → '}${initial?'进入 ':''}${esc(to)}</b><time>${new Date(h.created_at).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'})}</time></div><p>${esc(h.reason)}</p><small>${esc(h.actor_email)}</small></div></div>`}).join(''):'<p class="empty-inline">暂无阶段历史。</p>'}

function openDrawer(p){
  if(!p)return;
  const t=trendFor(p.id);
  const requirements=advanceRequirements(p),stageMarkers=stages.map((name,i)=>`<span class="stage-marker ${i<p.stage?'done':''} ${i===p.stage?'active':''}"><i>${i+1}</i>${esc(name)}</span>`).join('');
  $('#drawerEyebrow').textContent=`项目详情 · ${stages[p.stage]}`;$('#drawerTitle').textContent=p.name;
  $('#drawerContent').innerHTML=`<section class="drawer-block"><div class="drawer-section-head"><h3>项目介绍</h3>${isAdmin?`<button data-edit-project="${p.id}">编辑资料</button>`:''}</div><p>${esc(p.intro)}</p><div class="project-taxonomy"><span>${esc(p.category||'未分类')}</span><b>→</b><span>${esc(p.subcategory||'待补充')}</span></div></section><section class="drawer-block"><h3>趋势来源与假设</h3>${t?`<p class="team-line"><b>验证趋势</b># ${esc(t.name)}</p><p class="data-source">来源：<a href="${esc(t.url)}" target="_blank" rel="noreferrer">${esc(t.volume)}，${esc(t.growth)} ↗</a></p><p class="data-hypothesis">验证假设：${esc(t.hypothesis)}</p>`:'<p class="data-hypothesis">尚未建立趋势映射；可从“正在验证的趋势”中添加。</p>'}<p class="team-line"><b>负责人</b>${esc(p.owner)}</p><p class="team-line"><b>参与人员</b>${esc(p.members)}</p></section><section class="drawer-block experiment-block"><div class="drawer-section-head"><h3>验证实验</h3>${isAdmin?`<button data-add-experiment="${p.id}">＋ 新建一轮</button>`:''}</div><p class="experiment-intro">把假设、证据、结论和决策放在同一条记录中；每轮实验固定归属创建时的项目阶段。</p><div class="experiment-timeline">${experimentTimeline(p)}</div></section><section class="drawer-block"><div class="drawer-section-head"><h3>验证指标</h3>${isAdmin?`<button data-add-metric="${p.id}">＋ 添加</button>`:''}</div><div class="metric-data-list">${p.metrics.length?p.metrics.map(m=>metricCard(m,p)).join(''):'<p class="empty-inline">尚未录入验证指标。</p>'}</div></section><section class="drawer-block gate-block"><div class="drawer-section-head"><h3>${esc(stages[p.stage])}阶段门槛</h3><span>${p.progress}% 总进度</span></div>${gateChecklist(p)}</section><section class="drawer-block"><h3>项目流转</h3><div class="stage-path">${stageMarkers}</div>${isAdmin?`<div class="stage-action-stack"><button class="primary-btn advance-btn" data-advance="${p.id}" ${p.stage===4||requirements.length?'disabled':''}>${p.stage===4?'已进入最终阶段':requirements.length?`缺少 ${requirements.length} 项推进条件`:'推进至下一阶段 →'}</button><button class="stage-admin-btn" data-admin-stage="${p.id}">管理员回退 / 跨阶段调整</button></div>`:'<p class="readonly-note">当前为公开只读模式，只有管理员可以维护门槛与调整阶段。</p>'}</section><section class="drawer-block"><div class="drawer-section-head"><h3>下一步任务</h3>${isAdmin?`<button data-add-task="${p.id}">＋ 添加</button>`:''}</div><p class="next-summary">${esc(p.next)}</p><div class="task-list">${p.tasks.length?p.tasks.map(t=>taskRow(t,p)).join(''):'<p class="empty-inline">尚未添加任务。</p>'}</div></section><section class="drawer-block"><h3>阶段历史</h3><div class="stage-timeline">${stageTimeline(p)}</div></section><section class="drawer-block"><h3>最近记录</h3><div class="activity-list">${state.activity.filter(a=>a.project_id===p.id||a.text.includes(p.name)).slice(0,5).map(a=>`<p>${esc(a.at)} · ${esc(a.text)}</p>`).join('')||'<p>项目后续操作会记录在这里。</p>'}</div></section>${isAdmin?`<div class="drawer-actions"><button class="danger-btn" data-delete-project="${p.id}">删除项目</button></div>`:''}`;
  $('#detailDrawer').classList.add('open');$('#drawerOverlay').classList.add('open');$('#detailDrawer').setAttribute('aria-hidden','false');
}

function closeDrawer(){$('#detailDrawer').classList.remove('open');$('#drawerOverlay').classList.remove('open');$('#detailDrawer').setAttribute('aria-hidden','true')}
function setStage(stage){selectedStage=stage;$$('.stage-tab').forEach(tab=>{const active=tab.dataset.stage===String(stage);tab.classList.toggle('active',active);tab.setAttribute('aria-pressed',String(active))});const all=stage==='all';$('#allStages').classList.toggle('active',all);$('#allStages').setAttribute('aria-pressed',String(all));renderProjects()}
function renderStageDialogState(){const p=project(pendingProject);if(!p)return;const target=pendingStageMode==='admin'?Number($('#stageTarget').value):pendingStage,delta=target-p.stage,forward=delta>0,missing=forward?advanceRequirements(p):[],reasonRequired=delta<0||Math.abs(delta)>1;pendingStage=target;$('#advanceTitle').textContent=`${delta<0?'回退':delta>1?'跨阶段调整':'推进'}至「${stages[target]}」` ;$('#advanceCopy').textContent=`「${p.name}」将从「${stages[p.stage]}」调整至「${stages[target]}」。本次变更会写入不可变更的阶段历史。`;$('#stageReasonLabel').textContent=reasonRequired?'调整原因（必填）':'推进说明（选填）';$('#stageReason').required=reasonRequired;$('#stageReasonHint').textContent=reasonRequired?'回退或跨阶段调整必须说明依据与后续处理。':'不填写时，将记录为“当前阶段门槛与验证实验均已完成”。';$('#stageGateSummary').innerHTML=missing.length?`<div class="stage-dialog-blocked"><b>无法进入后续阶段，还缺少：</b><ul>${missing.map(item=>`<li>${esc(item.label)}</li>`).join('')}</ul></div>`:'<div class="stage-dialog-ready">阶段门槛与验证实验检查通过</div>';$('#stageSubmit').disabled=Boolean(missing.length);$('#stageSubmit').textContent=missing.length?'推进条件未完成':delta<0?'确认回退 →':delta>1?'确认跨阶段调整 →':'确认推进 →'}
function requestStage(projectId,target,mode='advance'){if(!requireAdmin())return;const p=project(projectId);if(!p)return;pendingProject=projectId;pendingStageMode=mode;$('#advanceForm').reset();const admin=mode==='admin';$('#stageTargetWrap').hidden=!admin;if(admin){const options=stages.map((name,i)=>({name,i})).filter(x=>x.i!==p.stage&&x.i!==p.stage+1);if(!options.length){notice('当前没有可用的回退或跨阶段目标。');return}$('#stageTarget').innerHTML=options.map(x=>`<option value="${x.i}">${x.i<p.stage?'回退':'跨阶段'} · ${x.name}</option>`).join('');pendingStage=options[0].i}else{pendingStage=target;if(target!==p.stage+1){notice('默认推进只能进入相邻的下一阶段。');return}}renderStageDialogState();$('#advanceDialog').showModal()}

function populateCategories(){const select=$('#projectCategory');select.innerHTML=`<option value="">选择一级类别</option>${Object.keys(appCategories).map(name=>`<option value="${name}">${name}</option>`).join('')}`}
function setSubcategories(category,value=''){const select=$('#projectSubcategory'),items=appCategories[category]||[];select.disabled=!items.length;select.innerHTML=items.length?`<option value="">选择二级分类</option>${items.map(name=>`<option value="${name}">${name}</option>`).join('')}`:'<option value="">请先选择项目类别</option>';select.value=items.includes(value)?value:''}
function openNewProject(){if(!requireAdmin())return;$('#projectForm').reset();$('#editProjectId').value='';setSubcategories('');$('#projectDialogTitle').textContent='创建新的增长项目';$('#projectSubmit').textContent='创建并进入立项 →';$('#projectDialog').showModal()}
function openEditProject(p){if(!requireAdmin())return;$('#editProjectId').value=p.id;$('#newProjectName').value=p.name;$('#newProjectIntro').value=p.intro;$('#projectCategory').value=appCategories[p.category]?p.category:'';setSubcategories($('#projectCategory').value,p.subcategory);$('#projectOwner').value=p.owner;$('#projectMembers').value=p.members;$('#projectDialogTitle').textContent='编辑项目资料';$('#projectSubmit').textContent='保存项目资料 →';$('#projectDialog').showModal()}
function openMetric(projectId,metricId=''){if(!requireAdmin())return;const p=project(projectId),m=metricId?p.metrics.find(x=>x.id===metricId):{name:'',value:'',source:'',note:''};$('#metricDialogTitle').textContent=metricId?'维护验证指标':'添加验证指标';$('#metricProjectId').value=projectId;$('#metricIndex').value=metricId;$('#metricName').value=m.name;$('#metricValue').value=m.value;$('#metricSource').value=m.source;$('#metricNote').value=m.note||'';$('#metricDialog').showModal()}
function openTask(projectId){if(!requireAdmin())return;$('#taskForm').reset();$('#taskProjectId').value=projectId;$('#taskDue').value=today();$('#taskDialog').showModal()}
function openExperiment(projectId){if(!requireAdmin())return;const p=project(projectId),end=new Date();end.setDate(end.getDate()+7);$('#experimentForm').reset();$('#experimentProjectId').value=p.id;$('#experimentMethod').innerHTML=experimentMethods.map(name=>`<option value="${name}">${name}</option>`).join('');$('#experimentStart').value=today();$('#experimentEnd').value=end.toISOString().slice(0,10);$('#experimentDialogTitle').textContent=`新建第 ${p.experiments.length+1} 轮验证实验`;$('#experimentStageNote').textContent=`本轮固定归属「${stages[p.stage]}」阶段`;$('#experimentDialog').showModal()}
function openExperimentResult(projectId,experimentId){if(!requireAdmin())return;const p=project(projectId),e=p.experiments.find(item=>item.id===experimentId);if(!e)return;$('#experimentResultForm').reset();$('#experimentResultProjectId').value=p.id;$('#experimentResultId').value=e.id;$('#experimentResultTitle').textContent=`第 ${e.round_no} 轮实验结果`;$('#experimentResultHypothesis').textContent=e.hypothesis;$('#experimentResultThreshold').textContent=`成功阈值 ${e.threshold_operator} ${Number(e.threshold_value).toLocaleString('zh-CN')} ${e.threshold_unit}`;$('#experimentActualValue').value=e.actual_value??'';$('#experimentActualData').value=e.actual_data||'';$('#experimentDataSource').value=e.data_source||'';$('#experimentConclusion').value=e.conclusion||'';$('#experimentDecision').innerHTML=`<option value="">选择最终决策</option>${experimentDecisions.map(name=>`<option value="${name}">${name}</option>`).join('')}`;$('#experimentDecision').value=e.decision||'';$('#experimentLearning').value=e.key_learning||'';renderExperimentPreview();$('#experimentResultDialog').showModal()}
function compareThreshold(actual,operator,target){return operator==='>='?actual>=target:operator==='>'?actual>target:operator==='<='?actual<=target:operator==='<'?actual<target:actual===target}
function renderExperimentPreview(){const p=project($('#experimentResultProjectId').value),e=p?.experiments.find(item=>item.id===$('#experimentResultId').value),raw=$('#experimentActualValue').value,node=$('#experimentAutoResult');if(!e||raw===''){node.textContent='输入实际数值后，系统将自动判断是否达到成功阈值。';node.className='experiment-auto-result';return}const actual=Number(raw),met=compareThreshold(actual,e.threshold_operator,Number(e.threshold_value));node.textContent=met?`自动判断：已达到成功阈值（${actual} ${e.threshold_unit}）`:`自动判断：未达到成功阈值（${actual} ${e.threshold_unit}）`;node.className=`experiment-auto-result ${met?'passed':'failed'}`}
function showDataGuide(){const list=state.activity.slice(0,8).map(a=>`<p><b>${esc(a.at)}</b><span>${esc(a.type)} · ${esc(a.text)}</span></p>`).join('');$('#dataLog').innerHTML=`<h3>最近线上记录</h3>${list||'<p>暂无记录</p>'}`;renderTrash();$('#dataDialog').showModal()}

$('#addProject').addEventListener('click',openNewProject);$('#emptyAddProject').addEventListener('click',openNewProject);$('#dataGuide').addEventListener('click',showDataGuide);$('#modelExplain').addEventListener('click',()=>$('#modelDialog').showModal());$('#modelExplainSecondary').addEventListener('click',()=>$('#modelDialog').showModal());
$('#authButton').addEventListener('click',async()=>{if(isAdmin){await db.auth.signOut();notice('已退出管理员账号。')}else{$('#authPassword').value='';authMessage('');$('#authDialog').showModal()}});
$('#projectCategory').addEventListener('change',e=>setSubcategories(e.target.value));
$$('.dialog-close,.cancel-dialog').forEach(b=>b.addEventListener('click',()=>b.closest('dialog').close()));

$('#authForm').addEventListener('submit',async e=>{e.preventDefault();const form=e.currentTarget,password=$('#authPassword').value;setBusy(form,true);authMessage('正在验证…');const {data,error}=await db.auth.signInWithPassword({email:ADMIN_EMAIL,password});setBusy(form,false);if(error){authMessage(error.message,'error');return}currentUser=data.user;renderAuth();$('#authDialog').close();notice('管理员登录成功。')});
$('#projectForm').addEventListener('submit',async e=>{e.preventDefault();const form=e.currentTarget,id=$('#editProjectId').value,name=$('#newProjectName').value.trim(),intro=$('#newProjectIntro').value.trim(),category=$('#projectCategory').value,subcategory=$('#projectSubcategory').value,owner=$('#projectOwner').value.trim(),members=$('#projectMembers').value.trim();if(!name||!intro||!category||!subcategory||!owner||!members)return;setBusy(form,true);const ok=await mutate(async()=>{if(id){const {error}=await db.from('projects').update({name,intro,category,subcategory,owner,members}).eq('id',id);if(error)throw error;await writeLog(id,`更新项目「${name}」的资料与分类`,'项目编辑')}else{const {data:p,error}=await db.from('projects').insert({name,intro,category,subcategory,trend:'待关联趋势',owner,members}).select().single();if(error)throw error;await writeLog(p.id,`创建项目「${name}」，归类为「${category} / ${subcategory}」`,'新增')}},id?'项目资料已保存。':`「${name}」已立项，可继续建立趋势映射。`);setBusy(form,false);if(ok){$('#projectDialog').close();form.reset();setSubcategories('');setStage(id?selectedStage:'0');const saved=id?project(id):state.projects.find(p=>p.name===name);if(saved)openDrawer(saved)}});

$('#openTrendMap').addEventListener('click',()=>{if(requireAdmin())$('#trendDialog').showModal()});
$('#trendForm').addEventListener('submit',async e=>{e.preventDefault();const form=e.currentTarget,name=$('#trendName').value.trim(),url=$('#trendUrl').value.trim(),projectId=$('#trendProject').value,hypothesis=$('#trendHypothesis').value.trim(),p=project(projectId);if(!name||!url||!p||!hypothesis)return;setBusy(form,true);const ok=await mutate(async()=>{const {error}=await db.from('trends').insert({project_id:projectId,name,url,hypothesis});if(error)throw error;const {error:projectError}=await db.from('projects').update({trend:name}).eq('id',projectId);if(projectError)throw projectError;await writeLog(projectId,`将趋势「${name}」关联到项目「${p.name}」`,'趋势映射')},`趋势已关联到「${p.name}」。`);setBusy(form,false);if(ok){$('#trendDialog').close();form.reset();selectedTrend=name;renderAll()}});

$('.decision-strip').addEventListener('click',e=>{const card=e.target.closest('[data-command-filter]');if(!card)return;selectedCommandFilter=selectedCommandFilter===card.dataset.commandFilter?'':card.dataset.commandFilter;renderCounts();renderProjects();document.querySelector('#projects').scrollIntoView({behavior:'smooth',block:'start'})});
$('#stageTabs').addEventListener('click',e=>{const tab=e.target.closest('.stage-tab');if(tab)setStage(tab.dataset.stage)});$('#allStages').addEventListener('click',()=>setStage('all'));$('#projectSearch').addEventListener('input',e=>{searchTerm=e.target.value.trim();renderProjects()});$('#clearFilter').addEventListener('click',()=>{selectedTrend='';selectedCommandFilter='';searchTerm='';$('#projectSearch').value='';setStage('all');renderCounts();renderTrends()});$('#projectRows').addEventListener('click',e=>{const row=e.target.closest('.project-row');if(row)openDrawer(project(row.dataset.project))});$('#projectRows').addEventListener('keydown',e=>{if(e.key==='Enter'){const row=e.target.closest('.project-row');if(row)openDrawer(project(row.dataset.project))}});
$('#trendList').addEventListener('click',e=>{const card=e.target.closest('.trend-card');if(!card)return;const t=state.trends.find(x=>x.id===card.dataset.trend);selectedTrend=selectedTrend===t.name?'':t.name;setStage('all');renderTrends();notice(selectedTrend?`已筛选关联「${t.name}」的项目。`:'已显示全部项目。')});$('#resetTrend').addEventListener('click',()=>{selectedTrend='';renderProjects();renderTrends()});$('#drawerClose').addEventListener('click',closeDrawer);$('#drawerOverlay').addEventListener('click',closeDrawer);

$('#drawerContent').addEventListener('click',async e=>{if(e.target.dataset.advance){const p=project(e.target.dataset.advance);requestStage(p.id,p.stage+1)}if(e.target.dataset.adminStage)requestStage(e.target.dataset.adminStage,null,'admin');if(e.target.dataset.addExperiment)openExperiment(e.target.dataset.addExperiment);if(e.target.dataset.experimentResult)openExperimentResult(e.target.dataset.project,e.target.dataset.experimentResult);if(e.target.dataset.addMetric)openMetric(e.target.dataset.addMetric);if(e.target.dataset.editMetric)openMetric(e.target.dataset.project,e.target.dataset.editMetric);if(e.target.dataset.addTask)openTask(e.target.dataset.addTask);if(e.target.dataset.editProject)openEditProject(project(e.target.dataset.editProject));if(e.target.dataset.deleteProject){const p=project(e.target.dataset.deleteProject);if(!confirm(`确认删除项目「${p.name}」？删除后可在“数据口径”中恢复。`))return;const ok=await mutate(async()=>{const {error}=await db.from('projects').update({deleted_at:new Date().toISOString()}).eq('id',p.id);if(error)throw error;await writeLog(p.id,`删除项目「${p.name}」`,'删除')},'项目已移入已删除列表。');if(ok)closeDrawer()}});
$('#drawerContent').addEventListener('change',async e=>{if(!isAdmin)return;const p=project(e.target.dataset.project);if(e.target.dataset.gate){const stage=Number(e.target.dataset.stage),gateKey=e.target.dataset.gate,completed=e.target.checked;const ok=await mutate(async()=>{const {error}=await db.rpc('set_project_stage_gate',{p_project_id:p.id,p_stage:stage,p_gate_key:gateKey,p_completed:completed});if(error)throw error},completed?'阶段门槛已完成，项目进度已自动更新。':'阶段门槛已重新打开，项目进度已自动更新。');if(ok)openDrawer(project(p.id));return}if(!e.target.dataset.task)return;const task=p.tasks.find(t=>t.id===e.target.dataset.task),done=e.target.checked;const ok=await mutate(async()=>{const {error}=await db.from('tasks').update({done}).eq('id',task.id);if(error)throw error;await writeLog(p.id,`${done?'完成':'重新打开'}任务「${task.title}」`,'任务')},done?'任务已完成。':'任务已重新打开。');if(ok)openDrawer(project(p.id))});

$('#stageTarget').addEventListener('change',renderStageDialogState);
$('#advanceForm').addEventListener('submit',async e=>{e.preventDefault();if(!pendingProject||pendingStage===null)return;const form=e.currentTarget,p=project(pendingProject),target=pendingStage,reason=$('#stageReason').value.trim(),delta=target-p.stage;if((delta<0||Math.abs(delta)>1)&&!reason){$('#stageReason').focus();notice('回退或跨阶段调整必须填写原因。');return}setBusy(form,true);const ok=await mutate(async()=>{const {error}=await db.rpc('change_project_stage',{p_project_id:p.id,p_target_stage:target,p_reason:reason});if(error)throw error},`已更新为「${stages[target]}」，阶段历史已保存。`);setBusy(form,false);if(ok){$('#advanceDialog').close();openDrawer(project(p.id));pendingProject='';pendingStage=null;pendingStageMode='advance'}});

$('#metricForm').addEventListener('submit',async e=>{e.preventDefault();const form=e.currentTarget,p=project($('#metricProjectId').value),metricId=$('#metricIndex').value,m={project_id:p.id,name:$('#metricName').value.trim(),value:$('#metricValue').value.trim(),source:$('#metricSource').value.trim(),note:$('#metricNote').value.trim()};if(!m.name||!m.value||!m.source)return;setBusy(form,true);const ok=await mutate(async()=>{const query=metricId?db.from('metrics').update(m).eq('id',metricId):db.from('metrics').insert(m);const {error}=await query;if(error)throw error;await writeLog(p.id,`${metricId?'更新':'添加'}项目「${p.name}」的指标「${m.name}」`,'指标')},'指标与数据来源已保存。');setBusy(form,false);if(ok){$('#metricDialog').close();openDrawer(project(p.id))}});

$('#experimentForm').addEventListener('submit',async e=>{e.preventDefault();const form=e.currentTarget,p=project($('#experimentProjectId').value),start=$('#experimentStart').value,end=$('#experimentEnd').value,thresholdRaw=$('#experimentThresholdValue').value,experiment={project_id:p.id,round_no:0,stage:p.stage,hypothesis:$('#experimentHypothesis').value.trim(),target_user:$('#experimentTargetUser').value.trim(),method:$('#experimentMethod').value,threshold_operator:$('#experimentThresholdOperator').value,threshold_value:Number(thresholdRaw),threshold_unit:$('#experimentThresholdUnit').value.trim(),start_date:start,end_date:end,created_by:currentUser.email};if(!experiment.hypothesis||!experiment.target_user||!experiment.method||thresholdRaw===''||!Number.isFinite(experiment.threshold_value)||!experiment.threshold_unit||!start||!end)return;if(end<start){notice('结束日期不能早于开始日期。');return}setBusy(form,true);const ok=await mutate(async()=>{const {data,error}=await db.from('validation_experiments').insert(experiment).select().single();if(error)throw error;await writeLog(p.id,`创建第 ${data.round_no} 轮验证实验「${experiment.hypothesis}」`,'实验')},'验证实验已创建，状态为“验证中”。');setBusy(form,false);if(ok){$('#experimentDialog').close();openDrawer(project(p.id))}});

$('#experimentActualValue').addEventListener('input',renderExperimentPreview);
$('#experimentResultForm').addEventListener('submit',async e=>{e.preventDefault();const form=e.currentTarget,p=project($('#experimentResultProjectId').value),experiment=p.experiments.find(item=>item.id===$('#experimentResultId').value),actualRaw=$('#experimentActualValue').value,actualValue=Number(actualRaw),result={actual_value:actualValue,actual_data:$('#experimentActualData').value.trim(),data_source:$('#experimentDataSource').value.trim(),conclusion:$('#experimentConclusion').value.trim(),decision:$('#experimentDecision').value,key_learning:$('#experimentLearning').value.trim(),completed_at:experiment.completed_at||new Date().toISOString()};if(actualRaw===''||!Number.isFinite(actualValue)||!result.actual_data||!result.data_source||!result.conclusion||!result.decision||!result.key_learning)return;const met=compareThreshold(actualValue,experiment.threshold_operator,Number(experiment.threshold_value));setBusy(form,true);const ok=await mutate(async()=>{const {error}=await db.from('validation_experiments').update(result).eq('id',experiment.id);if(error)throw error;await writeLog(p.id,`完成第 ${experiment.round_no} 轮验证实验，${met?'达到':'未达到'}成功阈值，决策「${result.decision}」`,'验证结论')},`实验结果已保存：${met?'达到':'未达到'}成功阈值。`);setBusy(form,false);if(ok){$('#experimentResultDialog').close();openDrawer(project(p.id))}});

$('#taskForm').addEventListener('submit',async e=>{e.preventDefault();const form=e.currentTarget,p=project($('#taskProjectId').value),task={project_id:p.id,title:$('#taskTitle').value.trim(),owner:$('#taskOwner').value.trim(),due:$('#taskDue').value,criteria:$('#taskDone').value.trim()};if(!task.title||!task.owner||!task.due||!task.criteria)return;setBusy(form,true);const ok=await mutate(async()=>{const {error}=await db.from('tasks').insert(task);if(error)throw error;const {error:projectError}=await db.from('projects').update({next_action:task.title}).eq('id',p.id);if(projectError)throw projectError;await writeLog(p.id,`为项目「${p.name}」添加任务「${task.title}」`,'任务')},'任务已添加，并成为当前下一步。');setBusy(form,false);if(ok){$('#taskDialog').close();openDrawer(project(p.id))}});

$('#trashList').addEventListener('click',async e=>{const id=e.target.dataset.restoreProject;if(!id||!requireAdmin())return;const p=deletedProjects.find(x=>x.id===id);const ok=await mutate(async()=>{const {error}=await db.from('projects').update({deleted_at:null}).eq('id',id);if(error)throw error;await writeLog(id,`恢复项目「${p.name}」`,'恢复')},`「${p.name}」已恢复。`);if(ok){renderTrash();showDataGuide()}});
$('#exportData').addEventListener('click',()=>{if(!requireAdmin())return;const payload=JSON.stringify({exportedAt:new Date().toISOString(),projects:state.projects,trends:state.trends,activity:state.activity,deletedProjects},null,2),blob=new Blob([payload],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=`company-project-board-${today()}.json`;a.click();URL.revokeObjectURL(url);notice('JSON 备份已导出。')});
document.addEventListener('keydown',e=>{if(e.key==='Escape')closeDrawer()});

async function initialize(){
  populateCategories();
  if(!db){setSync('线上配置缺失','error');renderAll();return}
  const {data}=await db.auth.getSession();currentUser=data.session?.user||null;renderAuth();
  db.auth.onAuthStateChange((_event,session)=>{currentUser=session?.user||null;renderAuth()});
  await loadData();
  realtimeChannel=db.channel('company-project-board-live').on('postgres_changes',{event:'*',schema:'public'},()=>{clearTimeout(reloadTimer);reloadTimer=setTimeout(()=>loadData({quiet:true}),350)}).subscribe(status=>{if(status==='CHANNEL_ERROR')setSync('实时连接中断','error')});
}

initialize();
