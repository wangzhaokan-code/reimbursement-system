const { createClient } = window.supabase;
const SUPABASE_URL = 'https://mfueaohkwfdhwmhsevjo.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_rzOBGZkTAx7wRFcdjDh9Vg_1UlMhwkF';
const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
const app = document.querySelector('#app');
const identity = document.querySelector('#identity');
const STATUS_LABELS = { draft:'草稿', submitted:'已提交', returned:'已退回', pending_payment:'待付款', paid:'已付款', withdrawn:'已撤回', voided:'已作废' };
const FILE_KINDS = new Set(['image','pdf']);
const state = { session:null, profile:null, subjects:[], permissions:[], claims:[], people:{users:[],invitations:[]}, mode:'list', selectedClaim:null, message:null, busy:false, dirty:false, saving:false, adminFilters:{subject:'',status:'',claimNumber:'',from:'',to:'',kind:'all',sort:'updated_desc'} };
const slotSaveTimers = new Map();

window.addEventListener('beforeunload', event=>{
  if(state.dirty || state.saving){
    event.preventDefault();
    event.returnValue='';
  }
});

window.addEventListener('error', event=>{
  console.error('页面运行错误', event.error||event.message);
  state.message={message:'页面加载失败，请刷新后重试',type:'error'};
  if(state.session)render();
});
window.addEventListener('unhandledrejection', event=>{
  console.error('未处理的异步错误', event.reason);
  state.message={message:'操作失败，请刷新后重试',type:'error'};
  if(state.session)render();
});

function statusLabel(value){ if(!STATUS_LABELS[value]){ console.warn('未知状态',value); return '未知状态'; } return STATUS_LABELS[value]; }
function yen(value){ return `¥${Number(value||0).toLocaleString('ja-JP')}`; }
function dateTime(value){ return value ? new Date(value).toLocaleString('zh-CN',{hour12:false}) : '—'; }
function esc(value){ return String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function uuid(){ return crypto.randomUUID(); }
function rows(file){ const raw=Array.isArray(file?.draft_slots)?file.draft_slots:[]; return Array.from({length:5},(_,i)=>raw[i]||{slot_index:i+1,expense_date:'',amount:'',note:''}); }
function complete(row){ return Boolean(row.expense_date) && Number.isInteger(Number(row.amount)) && Number(row.amount)>=0 && row.amount!==''; }
function partial(row){ return Boolean(row.expense_date)!==Boolean(row.amount); }
function claimFiles(claim){ return claim?.evidence_file||claim?.evidence_files||[]; }
function stats(claim){ const files=claimFiles(claim); const valid=files.flatMap(f=>rows(f).filter(complete)); return {files:files.filter(f=>!f.deleted_from_draft_at).length,receipts:valid.length,amount:valid.reduce((s,r)=>s+Number(r.amount),0)}; }
function flash(message,type='ok'){ state.message={message,type}; render(); }
function messageHtml(){ return state.message?`<div class="notice ${state.message.type==='error'?'error':'ok'}">${esc(state.message.message)}</div>`:''; }
async function rpc(name,args){ const {data,error}=await supabase.rpc(name,args); if(error){ console.error(name,error); throw new Error('操作失败，请刷新后重试'); } return Array.isArray(data)?data[0]||null:data; }
async function loadSession(){ const {data}=await supabase.auth.getSession(); state.session=data.session; if(!state.session){ renderLogin(); return false; } try{ await supabase.rpc('activate_user_access'); }catch(error){ console.error('activate_user_access',error); } const userId=state.session.user.id; const [profile,perms,subjects,claims,people]=await Promise.all([
  supabase.from('user_profile').select('*').eq('id',userId).maybeSingle(),
  supabase.from('user_subject_permission').select('*,expense_subject(*)').eq('user_id',userId).eq('is_active',true),
  supabase.from('expense_subject').select('*').order('subject_code'),
  supabase.from('reimbursement_claim').select('*,expense_subject(*),evidence_file(*)').order('updated_at',{ascending:false}),
  supabase.rpc('list_manageable_people'),
  supabase.from('user_subject_permission').select('*').eq('is_active',true)
 ]); state.profile=profile.data; state.permissions=perms.data||[]; state.subjects=subjects.data||[]; state.people=people.data||{users:[],invitations:[]}; const manageablePermissions=managedPermissions.data||[]; state.people.users=(state.people.users||[]).map(person=>({...person,permissions:manageablePermissions.filter(permission=>permission.user_id===person.id)})); const knownPeople=state.people.users||[]; state.claims=(claims.data||[]).map(claim=>({...claim,applicant:{display_name:knownPeople.find(person=>person.id===claim.applicant_user_id)?.short_name||knownPeople.find(person=>person.id===claim.applicant_user_id)?.full_name||knownPeople.find(person=>person.id===claim.applicant_user_id)?.display_name||knownPeople.find(person=>person.id===claim.applicant_user_id)?.email||'未知人员'}})); identity.innerHTML=`<span>${esc(state.profile?.short_name||state.profile?.display_name||state.session.user.email)}</span> <button id="logout">退出</button>`; document.querySelector('#logout')?.addEventListener('click',()=>supabase.auth.signOut()); return true; }
function applicationRootUrl(){ const path=location.pathname.endsWith('/')?location.pathname:location.pathname.slice(0,location.pathname.lastIndexOf('/')+1); return `${location.origin}${path}`; }
function invitationEmail(){ const value=new URLSearchParams(location.search).get('invite'); return value?value.trim().toLowerCase():''; }
function invitationLoginUrl(email){ const url=new URL(applicationRootUrl()); url.searchParams.set('invite',email); return url.toString(); }
function renderLogin(message=''){ identity.textContent=''; const invite=invitationEmail(); app.innerHTML=`<section class="card"><h1>登录公司业务管理平台</h1>${message?`<div class="notice error">${esc(message)}</div>`:''}${invite?`<p class="notice">这是发给 <b>${esc(invite)}</b> 的邀请，请使用该 Gmail 登录。</p>`:''}<p>仅允许已获得主体权限的 Google 账号访问。</p><button class="primary" id="login">使用 Google 登录</button><p class="muted">数据按数据库权限隔离，凭证文件仅向授权人员开放。</p></section>`; document.querySelector('#login').onclick=()=>{const queryParams={prompt:'select_account'}; if(invite)queryParams.login_hint=invite; const redirectTo=invite?invitationLoginUrl(invite):applicationRootUrl(); return supabase.auth.signInWithOAuth({provider:'google',options:{redirectTo,queryParams}});}; }
function allowedSubjects(){ const ids=new Set(state.permissions.map(p=>p.expense_subject_id)); return state.subjects.filter(s=>ids.has(s.id)); }
function managedSubjectIds(){ return new Set(state.permissions.filter(p=>p.role==='subject_admin'&&p.is_active).map(p=>p.expense_subject_id)); }
function businessSubjects(){ const ids=new Set(state.permissions.filter(p=>['applicant','reviewer','finance','subject_admin'].includes(p.role)&&p.is_active).map(p=>p.expense_subject_id)); return state.subjects.filter(s=>ids.has(s.id)); }
function canManageClaims(){ return state.profile?.is_platform_admin || state.permissions.some(p=>['reviewer','finance','subject_admin'].includes(p.role)&&p.is_active); }
function canManageSystem(){ return Boolean(state.profile?.is_platform_admin||managedSubjectIds().size); }
function personName(userId){ const person=state.people.users.find(user=>user.id===userId); return person?.short_name||person?.full_name||person?.display_name||person?.email||'未知人员'; }
function preferredSubjectId(){ const allowed=allowedSubjects(); if(allowed.length===1)return allowed[0].id; const recent=state.claims.find(c=>allowed.some(s=>s.id===c.expense_subject_id)); return recent?.expense_subject_id||allowed[0]?.id||''; }
function render(){ if(!state.session){renderLogin();return;} if(state.mode==='edit') renderEditor(); else if(state.mode==='detail') renderDetail(); else if(state.mode==='admin') renderAdmin(); else if(state.mode==='system') renderSystemAdmin(); else renderList(); }
function renderList(){ const mine=state.claims.filter(c=>c.applicant_user_id===state.session.user.id); const rowsHtml=mine.map(c=>{const s=stats(c);const editable=['draft','returned'].includes(c.status); return `<tr><td>${esc(c.claim_number)}</td><td>${esc(c.expense_subject?.display_name||'—')}</td><td>${s.files}</td><td>${s.receipts}</td><td>${yen(c.total_amount||s.amount)}</td><td>${statusLabel(c.status)}</td><td>${dateTime(c.last_autosaved_at||c.updated_at)}</td><td>${dateTime(c.submitted_at)}</td><td><button data-action="${editable?'edit':'view'}" data-id="${c.id}">${editable?'继续编辑':'查看详情'}</button>${c.status==='draft'?` <button class="danger" data-action="delete" data-id="${c.id}">删除草稿</button>`:''}</td></tr>`;}).join(''); app.innerHTML=`<section class="card"><div class="toolbar"><h1>我的报销</h1><button class="primary" id="newClaim">新建报销</button>${canManageClaims()?'<button id="admin">管理与统计</button>':''}${canManageSystem()?'<button id="system">系统管理</button>':''}</div>${messageHtml()}<p class="muted">这里只显示本人提交的报销；需要处理其他申请时请进入管理与统计。</p><table class="table"><thead><tr><th>申请编号</th><th>主体</th><th>文件数</th><th>收据数</th><th>总金额</th><th>状态</th><th>最近保存</th><th>提交时间</th><th>操作</th></tr></thead><tbody>${rowsHtml||'<tr><td colspan="9">暂无本人申请</td></tr>'}</tbody></table></section>`; document.querySelector('#newClaim').onclick=()=>{state.selectedClaim={draft:true,expense_subject_id:preferredSubjectId(),evidence_file:[]};state.message=null;state.mode='edit';render();}; document.querySelector('#admin')?.addEventListener('click',()=>{state.mode='admin';render();}); document.querySelector('#system')?.addEventListener('click',()=>{state.mode='system';render();}); app.querySelectorAll('[data-action]').forEach(b=>b.addEventListener('click',()=>handleListAction(b.dataset.action,b.dataset.id))); }
async function handleListAction(action,id){ const c=state.claims.find(x=>x.id===id); if(!c)return; if(action==='edit'){state.selectedClaim=c;state.mode='edit';state.message=null;render();} else if(action==='view'){state.selectedClaim=c;state.mode='detail';render();} else if(action==='delete'){ const confirmed=await askConfirmation(`确定删除草稿 ${c.claim_number}？文件数${stats(c).files}，收据数${stats(c).receipts}，总额${yen(stats(c).amount)}。`); if(!confirmed)return; try{await rpc('delete_reimbursement_draft',{p_claim_id:id,p_expected_version:c.version}); await loadSession(); flash('草稿已删除');}catch(error){console.error('delete_reimbursement_draft',error);flash(error.message,'error');} } }
function renderEditor(){ const c=state.selectedClaim; const subjects=allowedSubjects(); const subjectOptions=subjects.map(s=>`<option value="${s.id}" ${s.id===c.expense_subject_id?'selected':''}>${esc(s.display_name)}</option>`).join(''); const files=claimFiles(c); const fileHtml=files.map((f,fi)=>`<div class="file-card" data-file="${f.id}"><div class="file-head"><b>文件${fi+1}</b><span>${esc(f.original_filename||'')}</span><span class="muted">${statusLabel(f.upload_status||'draft')}</span><span>${f.upload_status==='ready'?'已上传':''}</span><button class="secondary" data-preview-file="${f.id}">查看凭证</button></div>${rows(f).map((r,ri)=>`<div class="slot ${partial(r)?'incomplete':''}"><span>第${ri+1}行</span><label>日期 <input type="date" data-file-id="${f.id}" data-slot-index="${ri+1}" data-slot-date value="${esc(r.expense_date||'')}"></label><label>金额（日元） <input type="text" inputmode="numeric" pattern="[0-9]*" data-file-id="${f.id}" data-slot-index="${ri+1}" data-slot-amount placeholder="请输入日币金额" value="${esc(r.amount||'')}"></label><label>备注 <input type="text" data-file-id="${f.id}" data-slot-index="${ri+1}" data-slot-note placeholder="可填写用途或说明" value="${esc(r.note||'')}"></label></div>`).join('')}</div>`).join(''); const submit= c.id&&c.status==='returned'||c.id&&c.status==='draft'; app.innerHTML=`<section class="card"><div class="toolbar"><button id="back">返回我的报销</button><h1>${c.id?esc(c.claim_number):'新建报销'}</h1><span class="muted" id="saveState">${c.id?'已加载':'首次有效编辑时创建草稿'}</span></div>${messageHtml()}<label>费用归属主体 <select id="subject" ${c.id&&c.status!=='draft'?'disabled':''}>${subjectOptions||'<option>没有可用主体权限</option>'}</select></label><hr><label>上传凭证（每批最多5个文件） <input id="files" type="file" accept="image/jpeg,image/png,image/heic,application/pdf" multiple ${c.id&&c.status!=='draft'?'disabled':''}></label><p class="muted upload-instruction">上传说明：单次最多上传 5 个照片或 PDF 文件；每个文件最多录入 5 张收据（以 1 张 A4 纸可放下为准），单次最多录入 25 条收据数据。</p><div id="fileList">${fileHtml||'<p class="muted">尚未上传文件。</p>'}</div><div class="summary"><b>完整收据数：${stats(c).receipts}</b><b>总金额：${yen(stats(c).amount)}</b></div><div class="actions">${submit?'<button class="primary" id="submit">提交审核</button>':''}<button id="clear">清空本地编辑</button></div><div id="previewModal" class="preview-modal" hidden></div></section>`; bindEditor(); app.querySelectorAll('[data-preview-file]').forEach(b=>b.addEventListener('click',()=>previewEvidence(files.find(f=>f.id===b.dataset.previewFile)))); }
function bindEditor(){ document.querySelector('#back').onclick=async()=>{await new Promise(resolve=>setTimeout(resolve,500));await saveCurrent(false);state.mode='list';await loadSession();render();}; document.querySelector('#clear').onclick=()=>{for(const timer of slotSaveTimers.values())clearTimeout(timer);slotSaveTimers.clear();state.dirty=false;state.saving=false;state.selectedClaim={draft:true,expense_subject_id:preferredSubjectId(),evidence_file:[]};render();}; document.querySelector('#subject')?.addEventListener('change',async e=>{state.dirty=true;state.selectedClaim.expense_subject_id=e.target.value;await saveCurrent(true);renderEditor();}); document.querySelector('#files')?.addEventListener('change',onFiles); app.querySelectorAll('[data-slot-date],[data-slot-amount],[data-slot-note]').forEach(input=>input.addEventListener('input',e=>{const f=claimFiles(state.selectedClaim).find(x=>x.id===e.target.dataset.fileId); if(!f)return; const slotRows=rows(f); const r=slotRows[Number(e.target.dataset.slotIndex)-1]; if(e.target.hasAttribute('data-slot-date'))r.expense_date=e.target.value; else if(e.target.hasAttribute('data-slot-amount'))r.amount=e.target.value===''?'':Math.max(0,Math.trunc(Number(e.target.value))); else r.note=e.target.value; f.draft_slots=slotRows;state.dirty=true;scheduleSlotSave(f);})); document.querySelector('#submit')?.addEventListener('click',submitCurrent); }
async function ensureDraft(){ if(state.selectedClaim.id)return true; if(!state.selectedClaim.expense_subject_id){flash('请选择费用归属主体','error');return false;} const created=await rpc('create_reimbursement_draft',{p_draft_creation_key:uuid(),p_expense_subject_id:state.selectedClaim.expense_subject_id}); state.selectedClaim={...state.selectedClaim,...created,evidence_file:[]}; return true; }
async function saveCurrent(allowCreate=true){
  if(state.busy)return;
  if(!state.selectedClaim.id){
    if(!allowCreate)return;
    if(!(await ensureDraft()))return;
  }
  state.busy=true;
  state.saving=true;
  try{
    const c=state.selectedClaim;
    const result=await rpc('autosave_reimbursement_claim',{p_claim_id:c.id,p_expected_version:c.version,p_expense_subject_id:c.expense_subject_id});
    state.selectedClaim={...c,...result};
    state.dirty=false;
    state.saving=false;
    document.querySelector('#saveState')?.replaceChildren(document.createTextNode(`已自动保存 ${new Date().toLocaleTimeString()}`));
  } catch(error) {
    state.dirty=true;
    state.saving=false;
    throw error;
  } finally {
    state.busy=false;
  }
}

async function saveFileSlots(file){
  if(!state.selectedClaim?.id || !file?.id)return;
  await saveCurrent();
  await rpc('autosave_evidence_draft_slots',{
    p_evidence_file_id:file.id,
    p_expected_claim_version:state.selectedClaim.version,
    p_draft_slots:rows(file)
  });
  await loadSession();
  state.selectedClaim=state.claims.find(x=>x.id===state.selectedClaim.id)||state.selectedClaim;
  state.dirty=false;
  state.saving=false;
}
function scheduleSlotSave(file){
  const key=`${state.selectedClaim?.id}:${file.id}`;
  const existing=slotSaveTimers.get(key);
  if(existing)clearTimeout(existing);
  const timer=setTimeout(async()=>{
    slotSaveTimers.delete(key);
    state.saving=true;
    try{
      await saveFileSlots(file);
      if(state.mode==='edit')renderEditor();
    }catch(err){
      console.error(err);
      state.dirty=true;
      state.saving=false;
      flash('保存失败，请刷新后重试','error');
    }
  },400);
  slotSaveTimers.set(key,timer);
}
async function onFiles(e){ const chosen=[...e.target.files]; e.target.value=''; if(chosen.length>5){flash('每批最多选择5个文件，可分批继续添加','error');return;} if(!(await ensureDraft()))return; for(const file of chosen){const ext=(file.name.split('.').pop()||'').toLowerCase();const kind=ext==='pdf'?'pdf':'image';if(!FILE_KINDS.has(kind))continue; try{const reserved=await rpc('reserve_evidence_file_upload',{p_claim_id:state.selectedClaim.id,p_expected_version:state.selectedClaim.version,p_original_filename:file.name,p_declared_mime_type:file.type||'application/octet-stream',p_declared_file_size:file.size,p_extension:ext,p_file_kind:kind}); const path=reserved.storage_path; const up=await supabase.storage.from(reserved.storage_bucket||'reimbursement-evidence').upload(path,file,{contentType:file.type||'application/octet-stream',upsert:false}); if(up.error)throw up.error; const completed=await rpc('complete_evidence_file_upload',{p_evidence_file_id:reserved.evidence_file_id,p_actual_mime_type:file.type,p_actual_file_size:file.size,p_actual_file_kind:kind}); state.selectedClaim.evidence_file=[...(state.selectedClaim.evidence_file||[]),{...completed,draft_slots:[]}]; state.selectedClaim.version=reserved.claim_version||state.selectedClaim.version; }catch(err){console.error(err);flash('文件上传失败，请重试','error');} } await loadSession(); state.selectedClaim=state.claims.find(x=>x.id===state.selectedClaim.id)||state.selectedClaim;state.mode='edit';render(); }
async function submitCurrent(){ const c=state.selectedClaim; const files=claimFiles(c); if(!c.expense_subject_id||!files.length){flash('请先选择主体并上传至少一个文件','error');return;} for(const f of files){const rs=rows(f);if(rs.some(partial)){flash('请完整填写日期和金额，或清空该行','error');return;}if(!rs.some(complete)){flash('每个文件至少填写一条完整日期和金额','error');return;}if(f.upload_status!=='ready'){flash('凭证仍在上传或上传失败，暂不能提交','error');return;}} if(!await askConfirmation('确认提交审核？提交后文件和收据将被锁定。'))return; try{await rpc('submit_reimbursement_claim',{p_claim_id:c.id,p_expected_version:c.version});state.dirty=false;state.saving=false;await loadSession();state.mode='list';flash('申请已提交');}catch(e){console.error('submit_reimbursement_claim',e);flash(e.message,'error');} }
function renderDetail(){ const c=state.selectedClaim,s=stats(c);const files=claimFiles(c);app.innerHTML=`<section class="card"><div class="toolbar"><button id="back">返回我的报销</button><h1>申请详情 ${esc(c.claim_number)}</h1></div>${messageHtml()}<p><b>${esc(c.expense_subject?.display_name||'—')}</b>｜状态：<b>${statusLabel(c.status)}</b>｜文件${s.files}｜收据${s.receipts}｜总额${yen(c.total_amount||s.amount)}</p><p>申请人：<b>${esc(personName(c.applicant_user_id))}</b></p><p>提交时间：${dateTime(c.submitted_at)}</p><table class="table"><thead><tr><th>文件</th><th>序号</th><th>日期</th><th>金额</th><th>备注</th><th>凭证</th></tr></thead><tbody>${files.flatMap(f=>rows(f).filter(complete).map(r=>`<tr><td>${esc(f.original_filename)}</td><td>${r.slot_index}</td><td>${esc(r.expense_date)}</td><td>${yen(r.amount)}</td><td>${esc(r.note||'—')}</td><td><button data-preview-file="${f.id}">查看凭证</button></td></tr>`)).join('')||'<tr><td colspan="6">暂无有效收据</td></tr>'}</tbody></table><div class="actions"><button id="claimPdf">下载单申请PDF</button></div><div class="actions" id="detailActions"></div><div id="previewModal" class="preview-modal" hidden></div></section>`;document.querySelector('#back').onclick=()=>{state.mode='list';render();};document.querySelector('#claimPdf').onclick=()=>downloadClaimPdf(c);app.querySelectorAll('[data-preview-file]').forEach(b=>b.addEventListener('click',()=>previewEvidence(files.find(f=>f.id===b.dataset.previewFile))));const actions=document.querySelector('#detailActions');if(['submitted','returned'].includes(c.status)&&c.applicant_user_id===state.session.user.id)actions.innerHTML='<button id="withdraw" class="danger">撤回申请</button>'; if(c.status==='paid')actions.innerHTML+='<button id="increase">创建增加更正</button><button id="decrease">创建减少更正</button>';document.querySelector('#withdraw')?.addEventListener('click',()=>runWithdraw(c));document.querySelector('#increase')?.addEventListener('click',()=>createCorrection(c,'increase'));document.querySelector('#decrease')?.addEventListener('click',()=>createCorrection(c,'decrease')); }
async function runWithdraw(c){if(!await askConfirmation('确认撤回申请？撤回后将回到草稿状态，可继续编辑、提交或删除。'))return;try{await rpc('withdraw_reimbursement_claim',{p_claim_id:c.id,p_expected_version:c.version,p_reason:null});await loadSession();state.mode='list';flash('申请已撤回并转为草稿');}catch(e){flash(e.message,'error');}}
async function createCorrection(c,direction){const amount=prompt('请输入正整数更正金额');const reason=prompt('请输入更正原因');if(!/^\d+$/.test(amount||'')||Number(amount)<=0||!reason?.trim()){flash('更正金额和原因必填','error');return;}try{await rpc('create_reimbursement_correction',{p_original_claim_id:c.id,p_expected_original_version:c.version,p_correction_creation_key:uuid(),p_correction_direction:direction,p_correction_amount:Number(amount),p_correction_reason:reason.trim()});await loadSession();state.mode='list';flash('更正申请已创建');}catch(e){flash(e.message,'error');}}
function filteredAdminClaims(){ const f=state.adminFilters; let claims=state.claims.filter(c=>!f.subject||c.expense_subject_id===f.subject).filter(c=>!f.status||c.status===f.status).filter(c=>!f.claimNumber||c.claim_number.toLowerCase().includes(f.claimNumber.toLowerCase())).filter(c=>f.kind==='all'||(f.kind==='correction'?Boolean(c.correction_amount):!c.correction_amount)); if(f.from)claims=claims.filter(c=>(c.submitted_at||c.created_at)?.slice(0,10)>=f.from); if(f.to)claims=claims.filter(c=>(c.submitted_at||c.created_at)?.slice(0,10)<=f.to); const dir=f.sort.endsWith('_asc')?1:-1; const key=f.sort.replace(/_(asc|desc)$/,''); claims.sort((a,b)=>{const av=key==='amount'?Number(a.total_amount||0):key==='number'?a.claim_number:(a.submitted_at||a.created_at||'');const bv=key==='amount'?Number(b.total_amount||0):key==='number'?b.claim_number:(b.submitted_at||b.created_at||'');return av< bv?-dir:av>bv?dir:0;}); return claims; }
function csvCell(v){return `"${String(v??'').replaceAll('"','""')}"`;}
function downloadCsv(filename,rows){const csv='\ufeff'+rows.map(r=>r.map(csvCell).join(',')).join('\r\n');const url=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8'}));const a=document.createElement('a');a.href=url;a.download=filename;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
function concatBytes(parts){const total=parts.reduce((n,p)=>n+p.length,0);const out=new Uint8Array(total);let offset=0;for(const part of parts){out.set(part,offset);offset+=part.length;}return out;}
function imagePdfFromCanvas(canvas){const jpeg=Uint8Array.from(atob(canvas.toDataURL('image/jpeg',.92).split(',')[1]),c=>c.charCodeAt(0));const width=canvas.width;const height=canvas.height;const encoder=new TextEncoder();const objects=[];objects.push(encoder.encode('<< /Type /Catalog /Pages 2 0 R >>'));objects.push(encoder.encode('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'));objects.push(encoder.encode(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 ${Math.round(height*595/width)}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`));objects.push(concatBytes([encoder.encode(`<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`),jpeg,encoder.encode('\nendstream')]));const pageHeight=Math.round(height*595/width);const stream=`q\n595 0 0 ${pageHeight} 0 0 cm\n/Im0 Do\nQ`;objects.push(encoder.encode(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`));const header=encoder.encode('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');const chunks=[header];const offsets=[0];let position=header.length;objects.forEach((obj,index)=>{offsets.push(position);const prefix=encoder.encode(`${index+1} 0 obj\n`);const suffix=encoder.encode('\nendobj\n');chunks.push(prefix,obj,suffix);position+=prefix.length+obj.length+suffix.length;});const xrefOffset=position;let xref=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n`;for(let i=1;i<offsets.length;i++)xref+=`${String(offsets[i]).padStart(10,'0')} 00000 n \n`;xref+=`trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;chunks.push(encoder.encode(xref));return new Blob(chunks,{type:'application/pdf'});}
function downloadPdf(filename,lines){const canvas=document.createElement('canvas');canvas.width=1400;canvas.height=Math.max(500,lines.length*48+80);const ctx=canvas.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.fillStyle='#111';ctx.font='30px -apple-system, BlinkMacSystemFont, "Hiragino Sans", sans-serif';lines.forEach((line,index)=>ctx.fillText(String(line),40,60+index*48));const url=URL.createObjectURL(imagePdfFromCanvas(canvas));const a=document.createElement('a');a.href=url;a.download=filename;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
function downloadClaimPdf(claim){const s=stats(claim);const lines=[`公司业务管理平台｜申请 ${claim.claim_number}`,`主体：${claim.expense_subject?.display_name||'—'}`,`申请人：${claim.applicant?.display_name||state.profile?.display_name||'—'}`,`状态：${statusLabel(claim.status)}`,`文件数：${s.files}　收据数：${s.receipts}`,`提交时间：${dateTime(claim.submitted_at)}`,...claimFiles(claim).flatMap(f=>rows(f).filter(complete).map((r,i)=>`文件${f.file_order||''} 收据${i+1}　${r.expense_date}　${yen(r.amount)}　备注：${r.note||'—'}`)),`总额：${yen(claim.total_amount||s.amount)}`];downloadPdf(`${claim.claim_number}.pdf`,lines);}
function downloadDashboardPdf(claims){const f=state.adminFilters;const normal=claims.filter(c=>!c.correction_amount&&c.status!=='voided');const increase=claims.filter(c=>c.correction_amount&&c.correction_amount>0).reduce((s,c)=>s+Number(c.correction_amount),0);const decrease=claims.filter(c=>c.correction_amount&&c.correction_amount<0).reduce((s,c)=>s+Math.abs(Number(c.correction_amount)),0);const original=normal.reduce((s,c)=>s+Number(c.total_amount||0),0);const voided=claims.filter(c=>c.status==='voided');const lines=['公司业务管理平台｜当前筛选结果',`筛选：主体=${f.subject||'全部'} 状态=${f.status?statusLabel(f.status):'全部'} 类型=${f.kind}`,`排序：${f.sort}`,`原始金额：${yen(original)}　增加：${yen(increase)}　减少：${yen(decrease)}`,`经营净额：${yen(original+increase-decrease)}`,`作废申请数：${voided.length}　作废原金额：${yen(voided.reduce((s,c)=>s+Number(c.total_amount||0),0))}`,...claims.map(c=>`${c.claim_number}　${c.expense_subject?.display_name||'—'}　${statusLabel(c.status)}　${yen(c.total_amount)}`)];downloadPdf('当前筛选结果.pdf',lines);}
async function previewEvidence(file){
  if(!file?.storage_path){flash('凭证路径不可用','error');return;}
  try{
    const bucket=file.storage_bucket||'reimbursement-evidence';
    const result=await supabase.storage.from(bucket).download(file.storage_path);
    if(result.error)throw result.error;
    const url=URL.createObjectURL(result.data);
    const modal=document.querySelector('#previewModal');
    if(!modal){URL.revokeObjectURL(url);return;}
    const isPdf=(file.file_kind==='pdf'||file.mime_type==='application/pdf');
    modal.hidden=false;
    modal.innerHTML=`<div class="preview-backdrop"><div class="preview-panel"><button class="preview-close">关闭</button>${isPdf?`<iframe title="凭证PDF预览" src="${url}"></iframe>`:`<img alt="凭证预览" src="${url}">`}</div></div>`;
    modal.querySelector('.preview-close').onclick=()=>{URL.revokeObjectURL(url);modal.hidden=true;modal.innerHTML='';};
  }catch(error){console.error('凭证预览失败',error);flash('凭证暂时无法打开，请刷新后重试','error');}
}
function downloadAdminClaimsCsv(claims){downloadCsv('当前筛选申请.csv',[['申请编号','主体','状态','金额','提交日期'],...claims.map(c=>[c.claim_number,c.expense_subject?.display_name,statusLabel(c.status),Number(c.total_amount||0),c.submitted_at?.slice(0,10)?.replaceAll('-','')||''])]);}
function downloadAdminReceiptsCsv(claims){const out=[['申请编号','主体','文件序号','收据序号','日期','金额','备注']];claims.forEach(c=>claimFiles(c).forEach(f=>rows(f).filter(complete).forEach((r,i)=>out.push([c.claim_number,c.expense_subject?.display_name,f.file_order,i+1,r.expense_date.replaceAll('-',''),Number(r.amount),r.note||'']))));downloadCsv('当前筛选收据明细.csv',out);}
async function renderSystemAdminLegacy(){
  if(!state.profile?.is_platform_admin){state.mode='list';render();return;}
  const [usersRes,permsRes,invitesRes]=await Promise.all([
    supabase.from('user_profile').select('*').order('email'),
    supabase.from('user_subject_permission').select('*,expense_subject(*)').order('granted_at',{ascending:false}),
    supabase.from('user_access_invitation').select('*,expense_subject(*)').order('created_at',{ascending:false})
  ]);
  const users=usersRes.data||[], perms=permsRes.data||[], invites=invitesRes.data||[];
  const subjectRows=state.subjects.map(s=>`<tr><td>${esc(s.display_name)}</td><td>${esc(s.subject_code)}</td><td>${s.subject_type==='internal_business_pool'?'内部业务池':'法人主体'}</td><td>${s.is_active?'启用':'已停用'}</td><td><button data-subject-edit="${s.id}">编辑</button></td></tr>`).join('');
  const userRows=users.map(u=>{const up=perms.filter(p=>p.user_id===u.id&&p.is_active);const labels=up.map(p=>`${p.expense_subject?.display_name||'—'}:${p.role}`).join('、');return `<tr><td>${esc(u.display_name)}</td><td>${esc(u.email)}</td><td>${u.is_platform_admin?'平台管理员':''}</td><td>${esc(labels||'无主体权限')}</td></tr>`;}).join('');
  const inviteRows=invites.map(i=>`<tr><td>${esc(i.normalized_email)}</td><td>${esc(i.expense_subject?.display_name||'—')}</td><td>${esc(i.role)}</td><td>${i.accepted_user_id?'已激活':(i.is_active?'待首次登录':'已撤销')}</td><td>${i.is_active&&!i.accepted_user_id?`<button data-invite-revoke="${i.id}">撤销</button>`:''}</td></tr>`).join('');
  app.innerHTML=`<section class="card"><div class="toolbar"><button id="back">返回我的报销</button><h1>系统管理</h1></div>${messageHtml()}<h2>主体管理</h2><form id="subjectForm" class="admin-form"><input name="subject_code" placeholder="主体代码" required><input name="display_name" placeholder="正式名称" required><input name="short_name" placeholder="简称"><select name="subject_type"><option value="corporation">法人主体</option><option value="internal_business_pool">内部业务池</option></select><label><input type="checkbox" name="is_legal_entity"> 法人</label><button class="primary">添加主体</button></form><table class="table"><thead><tr><th>名称</th><th>代码</th><th>类型</th><th>状态</th><th>操作</th></tr></thead><tbody>${subjectRows}</tbody></table><h2>人员与权限</h2><form id="inviteForm" class="admin-form"><input name="email" type="email" placeholder="Google邮箱" required><select name="subject_id">${state.subjects.filter(s=>s.is_active).map(s=>`<option value="${s.id}">${esc(s.display_name)}</option>`).join('')}</select><select name="role"><option value="applicant">申请人</option><option value="reviewer">审核人</option><option value="finance">财务</option><option value="subject_admin">主体管理员</option></select><button class="primary">添加待授权人员</button></form><table class="table"><thead><tr><th>姓名</th><th>Google邮箱</th><th>平台角色</th><th>主体角色</th></tr></thead><tbody>${userRows||'<tr><td colspan="4">暂无用户</td></tr>'}</tbody></table><h3>待首次登录授权</h3><table class="table"><thead><tr><th>Google邮箱</th><th>主体</th><th>角色</th><th>状态</th><th>操作</th></tr></thead><tbody>${inviteRows||'<tr><td colspan="5">暂无待授权</td></tr>'}</tbody></table></section>`;
  document.querySelector('#back').onclick=()=>{state.mode='list';render();};
  document.querySelector('#subjectForm').onsubmit=async e=>{e.preventDefault();const f=new FormData(e.currentTarget);try{await rpc('manage_expense_subject',{p_subject_id:null,p_subject_code:f.get('subject_code'),p_display_name:f.get('display_name'),p_short_name:f.get('short_name'),p_subject_type:f.get('subject_type'),p_is_legal_entity:f.get('is_legal_entity')==='on',p_is_active:true});await loadSession();state.mode='system';await renderSystemAdmin();flash('主体已添加');}catch(error){flash(error.message,'error');}};
  document.querySelector('#inviteForm').onsubmit=async e=>{e.preventDefault();const f=new FormData(e.currentTarget);try{await rpc('manage_user_access_invitation',{p_invitation_id:null,p_email:f.get('email'),p_expense_subject_id:f.get('subject_id'),p_role:f.get('role'),p_is_active:true});await renderSystemAdmin();flash('待首次登录授权已添加');}catch(error){flash(error.message,'error');}};
  app.querySelectorAll('[data-subject-edit]').forEach(b=>b.onclick=async()=>{const subject=state.subjects.find(s=>s.id===b.dataset.subjectEdit);if(!subject)return;const name=prompt('主体正式名称',subject.display_name);if(!name?.trim())return;const active=confirm('确定保持主体启用？点击取消将停用主体。');if(!confirm(`确认保存主体“${name.trim()}”吗？`))return;try{await rpc('manage_expense_subject',{p_subject_id:subject.id,p_subject_code:subject.subject_code,p_display_name:name.trim(),p_short_name:subject.short_name||'',p_subject_type:subject.subject_type,p_is_legal_entity:subject.is_legal_entity,p_is_active:active});await loadSession();await renderSystemAdmin();flash('主体已更新');}catch(error){flash(error.message,'error');}});
  app.querySelectorAll('[data-invite-revoke]').forEach(b=>b.onclick=async()=>{if(!confirm('确认撤销该待授权？'))return;try{await rpc('manage_user_access_invitation',{p_invitation_id:b.dataset.inviteRevoke,p_email:'',p_expense_subject_id:null,p_role:'applicant',p_is_active:false});await renderSystemAdmin();}catch(error){flash(error.message,'error');}});
}
const ROLE_LABELS={applicant:'申请人',reviewer:'审核人',finance:'财务',subject_admin:'主体管理员'};
function roleLabel(role){return ROLE_LABELS[role]||'未知角色';}
function matrixValue(target,subjectId,role,perms,invites){
  if(target.kind==='user')return perms.some(p=>p.user_id===target.id&&p.expense_subject_id===subjectId&&p.role===role&&p.is_active);
  return invites.some(i=>i.normalized_email===target.email&&i.expense_subject_id===subjectId&&i.role===role&&i.is_active&&!i.accepted_user_id);
}
function permissionMatrixHtmlV1(target,perms,invites){
  if(!target)return '';
  const rows=state.subjects.map(subject=>`<tr><th>${esc(subject.display_name)}${subject.is_active?'':' <span class="muted">（已停用）</span>'}</th>${Object.keys(ROLE_LABELS).map(role=>`<td><input type="checkbox" data-matrix-subject="${subject.id}" data-matrix-role="${role}" ${matrixValue(target,subject.id,role,perms,invites)?'checked':''}></td>`).join('')}</tr>`).join('');
  const emailField=target.kind==='pending'&&target.isNew?'<label>Google邮箱 <input id="matrixEmail" type="email" placeholder="name@example.com" required></label>':'';
  return `<section class="permission-editor"><div class="toolbar"><h3>${target.kind==='user'?`编辑权限：${esc(target.label)}`:target.isNew?'新增人员权限矩阵':`为 ${esc(target.email)} 设置权限`}</h3><button id="matrixCancel">取消</button></div>${emailField}<table class="table matrix"><thead><tr><th>费用归属主体</th>${Object.values(ROLE_LABELS).map(label=>`<th>${label}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table><button class="primary" id="matrixSave">保存权限</button></section>`;
}
async function savePermissionMatrixV1(target,perms,invites){
  const selected=[...app.querySelectorAll('[data-matrix-subject]:checked')].map(input=>({expense_subject_id:input.dataset.matrixSubject,role:input.dataset.matrixRole}));
  if(target.kind==='user'){
    await rpc('manage_user_subject_permissions',{p_user_id:target.id,p_permissions:selected});
  }else{
    if(target.isNew){target.email=String(document.querySelector('#matrixEmail')?.value||'').trim().toLowerCase();if(!target.email||!target.email.includes('@'))throw new Error('请输入有效的 Google 邮箱');}
    const existing=invites.filter(i=>i.normalized_email===target.email);
    const wanted=new Set(selected.map(x=>`${x.expense_subject_id}:${x.role}`));
    for(const invitation of existing){
      const key=`${invitation.expense_subject_id}:${invitation.role}`;
      if(!wanted.has(key)&&invitation.is_active)await rpc('manage_user_access_invitation',{p_invitation_id:invitation.id,p_email:'',p_expense_subject_id:null,p_role:'applicant',p_is_active:false});
    }
    for(const item of selected){
      const existingInvite=existing.find(i=>i.expense_subject_id===item.expense_subject_id&&i.role===item.role);
      if(!existingInvite||!existingInvite.is_active)await rpc('manage_user_access_invitation',{p_invitation_id:null,p_email:target.email,p_expense_subject_id:item.expense_subject_id,p_role:item.role,p_is_active:true});
    }
  }
}
async function renderSystemAdminV1(){
  if(!state.profile?.is_platform_admin){state.mode='list';render();return;}
  const [usersRes,permsRes,invitesRes]=await Promise.all([
    supabase.from('user_profile').select('*').order('email'),
    supabase.from('user_subject_permission').select('*,expense_subject(*)').order('granted_at',{ascending:false}),
    supabase.from('user_access_invitation').select('*,expense_subject(*)').order('created_at',{ascending:false})
  ]);
  const users=usersRes.data||[], perms=permsRes.data||[], invites=invitesRes.data||[];
  const target=state.systemPermissionTarget||null;
  const editSubject=state.systemSubjectId?state.subjects.find(s=>s.id===state.systemSubjectId):null;
  const subjectForm=state.systemSubjectId?`<form id="subjectForm" class="admin-form subject-form"><label>主体代码<input name="subject_code" aria-label="主体代码" placeholder="例如 GSA" value="${esc(editSubject?.subject_code||'')}" required><small>用于系统内部识别，必须唯一</small></label><label>正式名称<input name="display_name" aria-label="正式名称" placeholder="例如 株式会社GSA" value="${esc(editSubject?.display_name||'')}" required><small>对用户显示的完整名称</small></label><label>简称<input name="short_name" aria-label="简称" placeholder="例如 GSA" value="${esc(editSubject?.short_name||'')}"><small>列表或打印中的简短显示名</small></label><label>主体类型<select name="subject_type" aria-label="主体类型"><option value="corporation" ${!editSubject||editSubject.subject_type==='corporation'?'selected':''}>法人主体</option><option value="internal_business_pool" ${editSubject?.subject_type==='internal_business_pool'?'selected':''}>内部业务池</option></select><small>内部业务池不是法人</small></label><label>状态<select name="is_active" aria-label="状态"><option value="true" ${!editSubject||editSubject.is_active?'selected':''}>启用</option><option value="false" ${editSubject&&!editSubject.is_active?'selected':''}>停用</option></select><small>停用后不出现在新增权限默认列表</small></label><div class="subject-form-actions"><button class="primary">保存主体</button><button type="button" id="subjectCancel">取消</button></div></form>`:`<button class="primary" id="newSubject">＋ 添加主体</button>`;
  const subjectRows=state.subjects.map(subject=>`<tr><td>${esc(subject.display_name)}</td><td>${esc(subject.subject_code)}</td><td>${subject.subject_type==='internal_business_pool'?'内部业务池':'法人主体'}</td><td>${subject.is_active?'启用':'已停用'}</td><td><button data-subject-edit="${subject.id}">编辑</button></td></tr>`).join('');
  const userRows=users.map(user=>{const active=perms.filter(p=>p.user_id===user.id&&p.is_active);const countSubjects=new Set(active.map(p=>p.expense_subject_id)).size;return `<tr><td>${esc(user.display_name||'—')}</td><td>${esc(user.email||'—')}</td><td>${user.is_platform_admin?'平台管理员':'—'}</td><td>${active.length?`${countSubjects}个主体 / ${active.length}项权限`:'无主体权限'}</td><td><button data-user-edit="${user.id}">编辑权限</button></td></tr>`;}).join('');
  const pendingEmails=[...new Set(invites.filter(i=>!i.accepted_user_id).map(i=>i.normalized_email))];
  const inviteRows=pendingEmails.map(email=>{const emailInvites=invites.filter(i=>i.normalized_email===email&&!i.accepted_user_id);const count= emailInvites.filter(i=>i.is_active).length;return `<tr><td>${esc(email)}</td><td>待首次登录</td><td>${count}项权限</td><td><button data-pending-edit="${esc(email)}">编辑权限</button></td></tr>`;}).join('');
  const matrix=permissionMatrixHtml(target,perms,invites);
  app.innerHTML=`<section class="card"><div class="toolbar"><button id="back">返回我的报销</button><h1>系统管理</h1></div>${messageHtml()}<h2>主体管理</h2>${subjectForm}<table class="table"><thead><tr><th>正式名称</th><th>主体代码</th><th>类型</th><th>状态</th><th>操作</th></tr></thead><tbody>${subjectRows||'<tr><td colspan="5">暂无主体</td></tr>'}</tbody></table><h2>人员与权限</h2><button class="primary" id="addPerson">＋ 添加人员</button>${matrix}<table class="table"><thead><tr><th>姓名</th><th>Google邮箱</th><th>平台身份</th><th>主体权限摘要</th><th>操作</th></tr></thead><tbody>${userRows||'<tr><td colspan="5">暂无已激活人员</td></tr>'}</tbody></table><h3>待首次登录授权</h3>${!pendingEmails.length?'<p class="muted">暂无待首次登录授权</p>':`<table class="table"><thead><tr><th>Google邮箱</th><th>状态</th><th>权限摘要</th><th>操作</th></tr></thead><tbody>${inviteRows}</tbody></table>`}</section>`;
  document.querySelector('#back').onclick=()=>{state.systemPermissionTarget=null;state.systemSubjectId=null;state.mode='list';render();};
  document.querySelector('#newSubject')?.addEventListener('click',()=>{state.systemSubjectId='new';renderSystemAdmin();});
  document.querySelector('#subjectCancel')?.addEventListener('click',()=>{state.systemSubjectId=null;renderSystemAdmin();});
  document.querySelector('#subjectForm')?.addEventListener('submit',async event=>{event.preventDefault();const form=new FormData(event.currentTarget);const type=String(form.get('subject_type'));try{await rpc('manage_expense_subject',{p_subject_id:editSubject?.id||null,p_subject_code:form.get('subject_code'),p_display_name:form.get('display_name'),p_short_name:form.get('short_name'),p_subject_type:type,p_is_legal_entity:type==='corporation',p_is_active:form.get('is_active')==='true'});state.systemSubjectId=null;await loadSession();await renderSystemAdmin();flash(editSubject?'主体已更新':'主体已添加');}catch(error){flash(error.message,'error');}});
  app.querySelectorAll('[data-subject-edit]').forEach(button=>button.addEventListener('click',()=>{state.systemSubjectId=button.dataset.subjectEdit;state.systemPermissionTarget=null;renderSystemAdmin();}));
  document.querySelector('#addPerson')?.addEventListener('click',()=>{state.systemPermissionTarget={kind:'pending',email:'',label:'新增人员',isNew:true};renderSystemAdmin();});
  app.querySelectorAll('[data-user-edit]').forEach(button=>button.addEventListener('click',()=>{const user=users.find(item=>item.id===button.dataset.userEdit);if(!user)return;state.systemPermissionTarget={kind:'user',id:user.id,label:user.display_name||user.email};renderSystemAdmin();}));
  app.querySelectorAll('[data-pending-edit]').forEach(button=>button.addEventListener('click',()=>{state.systemPermissionTarget={kind:'pending',email:button.dataset.pendingEdit,label:button.dataset.pendingEdit};renderSystemAdmin();}));
  document.querySelector('#matrixCancel')?.addEventListener('click',()=>{state.systemPermissionTarget=null;renderSystemAdmin();});
  document.querySelector('#matrixSave')?.addEventListener('click',async()=>{try{await savePermissionMatrix(target,perms,invites);state.systemPermissionTarget=null;await renderSystemAdmin();flash('权限矩阵已保存');}catch(error){console.error(error);flash('权限保存失败，请刷新后重试','error');}});
}
function renderAdmin(){ const f=state.adminFilters; const claims=filteredAdminClaims(); const normal=claims.filter(c=>!c.correction_amount&&c.status!=='voided'); const original=normal.reduce((s,c)=>s+Number(c.total_amount||0),0); const increase=claims.filter(c=>c.correction_amount&&c.correction_amount>0).reduce((s,c)=>s+Number(c.correction_amount),0); const decrease=claims.filter(c=>c.correction_amount&&c.correction_amount<0).reduce((s,c)=>s+Math.abs(Number(c.correction_amount)),0); const voided=claims.filter(c=>c.status==='voided'); const subjectOptions=state.subjects.map(s=>`<option value="${s.id}" ${s.id===f.subject?'selected':''}>${esc(s.display_name)}</option>`).join(''); app.innerHTML=`<section class="card"><div class="toolbar"><button id="back">返回我的报销</button><h1>管理与统计</h1></div>${messageHtml()}<div class="filters"><label>主体<select id="adminSubject"><option value="">全部</option>${subjectOptions}</select></label><label>状态<select id="adminStatus"><option value="">全部</option>${Object.entries(STATUS_LABELS).map(([k,v])=>`<option value="${k}" ${k===f.status?'selected':''}>${v}</option>`).join('')}</select></label><label>申请编号<input id="adminNumber" value="${esc(f.claimNumber)}"></label><label>起始日期<input id="adminFrom" type="date" value="${f.from}"></label><label>结束日期<input id="adminTo" type="date" value="${f.to}"></label><label>类型<select id="adminKind"><option value="all">全部</option><option value="normal" ${f.kind==='normal'?'selected':''}>普通申请</option><option value="correction" ${f.kind==='correction'?'selected':''}>更正申请</option></select></label><label>排序<select id="adminSort"><option value="updated_desc">日期降序</option><option value="updated_asc">日期升序</option><option value="number_asc">编号升序</option><option value="number_desc">编号降序</option><option value="amount_desc">金额降序</option><option value="amount_asc">金额升序</option></select></label></div><div class="actions"><button id="claimsCsv">下载申请CSV</button><button id="receiptsCsv">下载收据CSV</button><button id="dashboardPdf">下载当前筛选PDF</button></div><div class="summary"><b>有效申请数：${normal.length}</b><b>有效收据数：${normal.reduce((s,c)=>s+stats(c).receipts,0)}</b><b>原始金额：${yen(original)}</b><b>增加：${yen(increase)}</b><b>减少：${yen(decrease)}</b><b>经营净额：${yen(original+increase-decrease)}</b><b>作废申请数：${voided.length}</b><b>作废原金额：${yen(voided.reduce((s,c)=>s+Number(c.total_amount||0),0))}</b></div><table class="table"><thead><tr><th>编号</th><th>主体</th><th>申请人</th><th>状态</th><th>金额</th><th>操作</th></tr></thead><tbody>${claims.map(c=>`<tr><td>${esc(c.claim_number)}</td><td>${esc(c.expense_subject?.display_name||'—')}</td><td>${esc(c.applicant?.display_name||'—')}</td><td>${statusLabel(c.status)}</td><td>${yen(c.total_amount)}</td><td><button data-admin-id="${c.id}">查看</button></td></tr>`).join('')||'<tr><td colspan="6">暂无匹配数据</td></tr>'}</tbody></table></section>`; document.querySelector('#back').onclick=()=>{state.mode='list';render();}; const rerender=()=>{state.adminFilters={subject:document.querySelector('#adminSubject').value,status:document.querySelector('#adminStatus').value,claimNumber:document.querySelector('#adminNumber').value,from:document.querySelector('#adminFrom').value,to:document.querySelector('#adminTo').value,kind:document.querySelector('#adminKind').value,sort:document.querySelector('#adminSort').value};renderAdmin();}; ['adminSubject','adminStatus','adminNumber','adminFrom','adminTo','adminKind','adminSort'].forEach(id=>document.querySelector('#'+id)?.addEventListener('change',rerender)); document.querySelector('#adminNumber')?.addEventListener('input',rerender); document.querySelector('#claimsCsv').onclick=()=>downloadAdminClaimsCsv(claims); document.querySelector('#receiptsCsv').onclick=()=>downloadAdminReceiptsCsv(claims); document.querySelector('#dashboardPdf').onclick=()=>downloadDashboardPdf(claims); app.querySelectorAll('[data-admin-id]').forEach(b=>b.onclick=()=>{state.selectedClaim=claims.find(c=>c.id===b.dataset.adminId);state.mode='detail';render();}); }
supabase.auth.onAuthStateChange(async()=>{await loadSession();render();});
function hasRole(subjectId, role){ return Boolean(state.permissions.some(p=>p.expense_subject_id===subjectId && p.role===role && p.is_active)); }
async function runReviewAction(claim, action){ const comment=action==='return'?prompt('请输入退回原因')||'':prompt('请输入审核意见')||''; if(action==='return'&&!comment.trim()){flash('退回原因必填','error');return;} if(!confirm(action==='return'?'确认退回该申请？':'确认审核通过并进入待付款？'))return; try{await rpc(action==='return'?'return_reimbursement_claim':'approve_reimbursement_claim',{p_claim_id:claim.id,p_expected_version:claim.version,p_comment:comment});await loadSession();state.selectedClaim=state.claims.find(c=>c.id===claim.id)||claim;state.mode='detail';flash(action==='return'?'申请已退回':'审核已通过');}catch(e){flash(e.message,'error');} }
async function runPayment(claim){const date=prompt('付款日期（YYYY-MM-DD）',new Date().toISOString().slice(0,10));const method=prompt('付款方式','银行转账');if(!date||!method)return;if(!confirm(`确认按申请总额${yen(claim.total_amount)}付款？`))return;try{await rpc('confirm_reimbursement_payment',{p_claim_id:claim.id,p_expected_version:claim.version,p_payment_date:date,p_payment_method:method,p_payment_note:''});await loadSession();state.selectedClaim=state.claims.find(c=>c.id===claim.id)||claim;state.mode='detail';flash('付款已确认');}catch(e){flash(e.message,'error');}}
function askRequiredReason(title){return new Promise(resolve=>{const modal=document.createElement('div');modal.className='reason-modal';modal.innerHTML=`<div class="reason-dialog" role="dialog" aria-modal="true"><h3>${esc(title)}</h3><label>原因<textarea rows="4" data-reason-input></textarea></label><div class="actions"><button type="button" data-reason-cancel>取消</button><button type="button" class="primary" data-reason-confirm>确认</button></div></div>`;document.body.appendChild(modal);const input=modal.querySelector('[data-reason-input]');const close=value=>{modal.remove();resolve(value);};modal.querySelector('[data-reason-cancel]').onclick=()=>close(null);modal.querySelector('[data-reason-confirm]').onclick=()=>{const value=input.value.trim();if(!value){input.focus();return;}close(value);};input.focus();});}
function askConfirmation(title){return new Promise(resolve=>{const modal=document.createElement('div');modal.className='reason-modal';modal.innerHTML=`<div class="reason-dialog" role="dialog" aria-modal="true"><h3>${esc(title)}</h3><div class="actions"><button type="button" data-confirm-cancel>取消</button><button type="button" class="primary" data-confirm-ok>确认</button></div></div>`;document.body.appendChild(modal);const close=value=>{modal.remove();resolve(value);};modal.querySelector('[data-confirm-cancel]').onclick=()=>close(false);modal.querySelector('[data-confirm-ok]').onclick=()=>close(true);});}
async function runVoid(claim){const reason=await askRequiredReason('请输入作废原因');if(!reason)return;const confirmed=await askConfirmation('确认作废该申请？文件、收据和审计记录将保留。');if(!confirmed)return;try{await rpc('void_reimbursement_claim',{p_claim_id:claim.id,p_expected_version:claim.version,p_reason:reason});await loadSession();state.selectedClaim=state.claims.find(c=>c.id===claim.id)||claim;state.mode='detail';flash('申请已作废');}catch(e){flash(e.message,'error');}}
const originalRenderDetail = renderDetail;
renderDetail = function(){ originalRenderDetail(); const c=state.selectedClaim; const actions=document.querySelector('#detailActions'); if(!actions||!c)return; if(hasRole(c.expense_subject_id,'reviewer')&&c.status==='submitted'){actions.insertAdjacentHTML('beforeend','<button data-review="return" class="danger">审核退回</button><button data-review="approve" class="primary">审核通过</button>');actions.querySelector('[data-review="return"]').onclick=()=>runReviewAction(c,'return');actions.querySelector('[data-review="approve"]').onclick=()=>runReviewAction(c,'approve');} if(hasRole(c.expense_subject_id,'finance')&&c.status==='pending_payment'){actions.insertAdjacentHTML('beforeend','<button data-pay class="primary">确认付款</button>');actions.querySelector('[data-pay]').onclick=()=>runPayment(c);} if(hasRole(c.expense_subject_id,'subject_admin')&&['submitted','returned','pending_payment'].includes(c.status)){actions.insertAdjacentHTML('beforeend','<button data-void class="danger">作废申请</button>');actions.querySelector('[data-void]').onclick=()=>runVoid(c);} };

async function renderSystemAdmin(){
  if(!canManageSystem()){state.mode='list';render();return;}
  const platform=Boolean(state.profile?.is_platform_admin);
  const managedIds=managedSubjectIds();
  const visibleSubjects=platform?state.subjects:state.subjects.filter(subject=>managedIds.has(subject.id));
  const users=state.people.users||[];
  const invites=state.people.invitations||[];
  const perms=users.flatMap(user=>(user.permissions||[]).map(permission=>({...permission,user_id:user.id,is_active:true})));
  const target=state.systemPermissionTarget||null;
  const editSubject=state.systemSubjectId?state.subjects.find(subject=>subject.id===state.systemSubjectId):null;
  const subjectForm=platform?(state.systemSubjectId?'<form id="subjectForm" class="admin-form subject-form"><label>主体代码<input name="subject_code" aria-label="主体代码" placeholder="例如 GSA" value="'+esc(editSubject?.subject_code||'')+'" required><small>用于系统内部识别，必须唯一</small></label><label>正式名称<input name="display_name" aria-label="正式名称" placeholder="例如 株式会社GSA" value="'+esc(editSubject?.display_name||'')+'" required><small>对用户显示的完整名称</small></label><label>简称<input name="short_name" aria-label="简称" placeholder="例如 GSA" value="'+esc(editSubject?.short_name||'')+'"><small>列表或打印中的简短显示名</small></label><label>主体类型<select name="subject_type" aria-label="主体类型"><option value="corporation" '+(!editSubject||editSubject.subject_type==='corporation'?'selected':'')+'>法人主体</option><option value="internal_business_pool" '+(editSubject?.subject_type==='internal_business_pool'?'selected':'')+'>内部业务池</option></select><small>内部业务池不是法人</small></label><label>状态<select name="is_active" aria-label="状态"><option value="true" '+(!editSubject||editSubject.is_active?'selected':'')+'>启用</option><option value="false" '+(editSubject&&!editSubject.is_active?'selected':'')+'>停用</option></select><small>停用后不出现在新增权限默认列表</small></label><div class="subject-form-actions"><button class="primary">保存主体</button><button type="button" id="subjectCancel">取消</button></div></form>':'<button class="primary" id="newSubject">＋ 添加主体</button>'):'';
  const subjectRows=visibleSubjects.map(subject=>'<tr><td>'+esc(subject.display_name)+'</td><td>'+esc(subject.subject_code)+'</td><td>'+(subject.subject_type==='internal_business_pool'?'内部业务池':'法人主体')+'</td><td>'+(subject.is_active?'启用':'已停用')+'</td><td>'+(platform?'<button data-subject-edit="'+subject.id+'">编辑</button>':'—')+'</td></tr>').join('');
  const userRows=users.map(user=>{
    const active=(user.permissions||[]).filter(permission=>permission.is_active);
    const summary=permissionSummary(user);
    const canEdit=platform||active.some(permission=>managedIds.has(permission.expense_subject_id)&&permission.role==='subject_admin');
    return '<tr><td>'+esc(user.short_name||user.full_name||user.display_name||'—')+'</td><td>'+esc(user.email||'—')+'</td><td>'+(user.status==='disabled'?'已停用':(user.is_platform_admin?'平台管理员':'已激活'))+'</td><td class="permission-summary">'+esc(summary||'无主体权限')+'</td><td><button data-user-profile="'+user.id+'" '+(canEdit?'':'disabled')+'>编辑资料</button> <button data-user-edit="'+user.id+'" '+(canEdit?'':'disabled')+'>编辑权限</button>'+(platform&&!user.is_platform_admin&&user.status!=='disabled'?' <button class="danger" data-user-disable="'+user.id+'">停用</button>':'')+'</td></tr>';
  }).join('');
  const pendingEmails=[...new Set(invites.filter(invite=>!invite.accepted_user_id&&invite.is_active).map(invite=>invite.normalized_email))];
  const inviteRows=pendingEmails.map(email=>{const emailInvites=invites.filter(invite=>invite.normalized_email===email&&!invite.accepted_user_id&&invite.is_active);const first=emailInvites[0];return '<tr><td>'+esc(email)+'</td><td>'+esc(first?.short_name||first?.full_name||'—')+'</td><td>待首次登录</td><td>'+emailInvites.length+'项权限</td><td><button data-pending-edit="'+esc(email)+'">编辑权限</button> <button data-invite-link="'+esc(email)+'">复制登录链接</button> <button class="danger" data-pending-delete="'+esc(email)+'">删除</button></td></tr>';}).join('');
  const matrix=permissionMatrixHtml(target,perms,invites,visibleSubjects);
  app.innerHTML='<section class="card"><div class="toolbar"><button id="back">返回我的报销</button><h1>系统管理</h1></div>'+messageHtml()+(platform?'<h2>主体管理</h2>':'')+subjectForm+(platform?'<table class="table"><thead><tr><th>正式名称</th><th>主体代码</th><th>类型</th><th>状态</th><th>操作</th></tr></thead><tbody>'+(subjectRows||'<tr><td colspan="5">暂无主体</td></tr>')+'</tbody></table>':'')+'<h2>人员与权限</h2><p class="muted">'+(platform?'平台管理员可管理全部主体；主体管理员只能管理自己负责的主体。':'当前仅显示您负责主体范围内的人员。')+'</p><button class="primary" id="addPerson">＋ 添加人员</button>'+matrix+'<table class="table"><thead><tr><th>简称</th><th>Google邮箱</th><th>状态</th><th>主体权限摘要</th><th>操作</th></tr></thead><tbody>'+(userRows||'<tr><td colspan="5">暂无可管理人员</td></tr>')+'</tbody></table><h3>待首次登录授权</h3>'+(pendingEmails.length?'<table class="table"><thead><tr><th>Google邮箱</th><th>简称</th><th>状态</th><th>权限摘要</th><th>操作</th></tr></thead><tbody>'+inviteRows+'</tbody></table>':'<p class="muted">暂无待首次登录授权</p>')+'</section>';
  document.querySelector('#back').onclick=()=>{state.systemPermissionTarget=null;state.systemSubjectId=null;state.mode='list';render();};
  document.querySelector('#newSubject')?.addEventListener('click',()=>{state.systemSubjectId='new';renderSystemAdmin();});
  document.querySelector('#subjectCancel')?.addEventListener('click',()=>{state.systemSubjectId=null;renderSystemAdmin();});
  document.querySelector('#subjectForm')?.addEventListener('submit',async event=>{event.preventDefault();const form=new FormData(event.currentTarget);const type=String(form.get('subject_type'));try{await rpc('manage_expense_subject',{p_subject_id:editSubject?.id||null,p_subject_code:form.get('subject_code'),p_display_name:form.get('display_name'),p_short_name:form.get('short_name'),p_subject_type:type,p_is_legal_entity:type==='corporation',p_is_active:form.get('is_active')==='true'});state.systemSubjectId=null;await loadSession();await renderSystemAdmin();flash(editSubject?'主体已更新':'主体已添加');}catch(error){flash(error.message,'error');}});
  app.querySelectorAll('[data-subject-edit]').forEach(button=>button.addEventListener('click',()=>{state.systemSubjectId=button.dataset.subjectEdit;state.systemPermissionTarget=null;renderSystemAdmin();}));
  document.querySelector('#addPerson')?.addEventListener('click',()=>{state.systemPermissionTarget={kind:'pending',email:'',label:'新增人员',isNew:true};renderSystemAdmin();});
  app.querySelectorAll('[data-user-edit]').forEach(button=>button.addEventListener('click',()=>{const user=users.find(item=>item.id===button.dataset.userEdit);if(!user)return;state.systemPermissionTarget={kind:'user',id:user.id,label:user.short_name||user.full_name||user.display_name||user.email};renderSystemAdmin();}));
  app.querySelectorAll('[data-pending-edit]').forEach(button=>button.addEventListener('click',()=>{state.systemPermissionTarget={kind:'pending',email:button.dataset.pendingEdit,label:button.dataset.pendingEdit};renderSystemAdmin();}));
  app.querySelectorAll('[data-user-profile]').forEach(button=>button.addEventListener('click',()=>{const user=users.find(item=>item.id===button.dataset.userProfile);if(user)editPersonProfile(user,platform,managedIds);}));
  app.querySelectorAll('[data-user-disable]').forEach(button=>button.addEventListener('click',async()=>{const user=users.find(item=>item.id===button.dataset.userDisable);if(!user||!confirm('确认停用 '+(user.short_name||user.email)+'？'))return;try{await rpc('manage_person_profile',{p_user_id:user.id,p_email:user.email,p_short_name:user.short_name||'',p_full_name:user.full_name||user.display_name||'',p_status:'disabled'});await loadSession();await renderSystemAdmin();flash('人员已停用');}catch(error){flash(error.message,'error');}}));
  app.querySelectorAll('[data-pending-delete]').forEach(button=>button.addEventListener('click',async()=>{if(!confirm('确认删除待首次登录人员 '+button.dataset.pendingDelete+'？'))return;const email=button.dataset.pendingDelete;for(const invite of invites.filter(item=>item.normalized_email===email&&!item.accepted_user_id)){await rpc('manage_user_access_invitation',{p_invitation_id:invite.id,p_email:'',p_expense_subject_id:null,p_role:'applicant',p_is_active:false});}await loadSession();await renderSystemAdmin();flash('待授权人员已删除');}));
  app.querySelectorAll('[data-invite-link]').forEach(button=>button.addEventListener('click',async()=>{const link=invitationLoginUrl(button.dataset.inviteLink);try{await navigator.clipboard.writeText(link);flash('登录链接已复制，请发送给对应 Gmail');}catch(error){console.error('copy invitation link',error);window.prompt('请复制此登录链接',link);}}));
  document.querySelector('#matrixCancel')?.addEventListener('click',()=>{state.systemPermissionTarget=null;renderSystemAdmin();});
  document.querySelector('#matrixSave')?.addEventListener('click',async()=>{try{await savePermissionMatrix(target,perms,invites,visibleSubjects);state.systemPermissionTarget=null;await loadSession();await renderSystemAdmin();flash('权限矩阵已保存');}catch(error){console.error(error);flash('权限保存失败，请刷新后重试','error');}});
}
function activeSubjectForUser(user,managedIds){return (user.permissions||[]).find(permission=>managedIds.has(permission.expense_subject_id))?.expense_subject_id||[...managedIds][0]||'';}
function activeRolesForSubject(user,subjectId){return (user.permissions||[]).filter(permission=>permission.expense_subject_id===subjectId&&permission.is_active).map(permission=>permission.role);}
function permissionSummary(user){const groups=new Map();for(const permission of (user.permissions||[]).filter(item=>item.is_active)){const subject=state.subjects.find(item=>item.id===permission.expense_subject_id);const name=subject?.display_name||'未知主体';if(!groups.has(name))groups.set(name,[]);groups.get(name).push(roleLabel(permission.role));}return [...groups].map(([subject,roles])=>subject+'：'+roles.join('、')).join('\n');}
async function editPersonProfile(user,platform,managedIds){const modal=document.createElement('div');modal.className='reason-modal';modal.innerHTML='<div class="reason-dialog" role="dialog" aria-modal="true"><h3>编辑人员资料</h3><label>人员简称<input data-profile-short value="'+esc(user.short_name||user.display_name||'')+'"></label><label>人员姓名<input data-profile-full value="'+esc(user.full_name||user.display_name||'')+'"></label>'+(platform?'<label>状态<select data-profile-status><option value="active" '+(user.status!=='disabled'?'selected':'')+'>已激活</option><option value="disabled" '+(user.status==='disabled'?'selected':'')+'>已停用</option></select></label>':'')+'<div class="actions"><button type="button" data-profile-cancel>取消</button><button type="button" class="primary" data-profile-save>保存</button></div></div>';document.body.appendChild(modal);const close=()=>modal.remove();modal.querySelector('[data-profile-cancel]').onclick=close;modal.querySelector('[data-profile-save]').onclick=async()=>{const shortName=modal.querySelector('[data-profile-short]').value.trim();const fullName=modal.querySelector('[data-profile-full]').value.trim();if(!shortName||!fullName){flash('人员简称和人员姓名均必填','error');return;}try{if(platform)await rpc('manage_person_profile',{p_user_id:user.id,p_email:user.email,p_short_name:shortName,p_full_name:fullName,p_status:modal.querySelector('[data-profile-status]').value});else{const subjectId=activeSubjectForUser(user,managedIds);await rpc('manage_subject_person',{p_user_id:user.id,p_email:user.email,p_short_name:shortName,p_full_name:fullName,p_expense_subject_id:subjectId,p_roles:activeRolesForSubject(user,subjectId),p_disable:false});}close();await loadSession();await renderSystemAdmin();flash('人员资料已保存');}catch(error){console.error('manage person profile',error);flash(error.message,'error');}};}

function permissionMatrixHtml(target,perms,invites,visibleSubjects){
  if(!target)return '';
  const subjects=visibleSubjects||state.subjects;
  const rows=subjects.map(subject=>{
    const cells=Object.keys(ROLE_LABELS).map(role=>'<td><input type="checkbox" data-matrix-subject="'+subject.id+'" data-matrix-role="'+role+'" '+(matrixValue(target,subject.id,role,perms,invites)?'checked':'')+'></td>').join('');
    return '<tr><th>'+esc(subject.display_name)+(subject.is_active?'':' <span class="muted">（已停用）</span>')+'</th>'+cells+'</tr>';
  }).join('');
  const targetInvite=target.kind==='pending'&&target.email?invites.find(invite=>invite.normalized_email===target.email):null;
  const fields=target.kind==='pending'?'<div class="admin-form"><label>Gmail<input id="matrixEmail" type="email" value="'+esc(target.email||'')+'" placeholder="XXXX@gmail.com" '+(target.isNew?'':'readonly')+' required></label><label>人员简称<input id="matrixShortName" value="'+esc(targetInvite?.short_name||'')+'" required></label><label>人员姓名<input id="matrixFullName" value="'+esc(targetInvite?.full_name||'')+'" required></label></div>':'';
  return '<section class="permission-editor"><div class="toolbar"><h3>'+ (target.kind==='user'?'编辑权限：'+esc(target.label):target.isNew?'新增人员权限矩阵':'为 '+esc(target.email)+' 设置权限') +'</h3><button id="matrixCancel">取消</button></div>'+fields+'<table class="table matrix"><thead><tr><th>费用归属主体</th>'+Object.values(ROLE_LABELS).map(label=>'<th>'+label+'</th>').join('')+'</tr></thead><tbody>'+rows+'</tbody></table><button class="primary" id="matrixSave">保存权限</button></section>';
}
async function savePermissionMatrix(target,perms,invites,visibleSubjects){
  const selected=[...app.querySelectorAll('[data-matrix-subject]:checked')].map(input=>({expense_subject_id:input.dataset.matrixSubject,role:input.dataset.matrixRole}));
  if(target.kind==='user'&&state.profile?.is_platform_admin){
    await rpc('manage_user_subject_permissions',{p_user_id:target.id,p_permissions:selected});
    return;
  }
  const subjects=visibleSubjects||state.subjects;
  const user=state.people.users.find(item=>item.id===target.id);
  if(target.kind==='user'){
    for(const subject of subjects){
      const roles=selected.filter(item=>item.expense_subject_id===subject.id).map(item=>item.role);
      await rpc('manage_subject_person',{p_user_id:target.id,p_email:user?.email||'',p_short_name:user?.short_name||'',p_full_name:user?.full_name||user?.display_name||'',p_expense_subject_id:subject.id,p_roles:roles,p_disable:false});
    }
    return;
  }
  const email=String(document.querySelector('#matrixEmail')?.value||target.email||'').trim().toLowerCase();
  const shortName=String(document.querySelector('#matrixShortName')?.value||'').trim();
  const fullName=String(document.querySelector('#matrixFullName')?.value||'').trim();
  if(!email||!email.includes('@')||!shortName||!fullName)throw new Error('Google邮箱、人员简称和人员姓名均必填');
  target.email=email;
  for(const subject of subjects){
    const roles=selected.filter(item=>item.expense_subject_id===subject.id).map(item=>item.role);
    if(roles.length||state.permissions.some(permission=>permission.expense_subject_id===subject.id&&permission.role==='subject_admin')){
      await rpc('manage_subject_person',{p_user_id:null,p_email:email,p_short_name:shortName,p_full_name:fullName,p_expense_subject_id:subject.id,p_roles:roles,p_disable:false});
    }
  }
}

// 管理统计只显示当前用户可管理主体范围，数据查询仍由 Supabase RLS 约束。
const _renderAdminScoped = renderAdmin;
renderAdmin = function(){
  const allSubjects = state.subjects;
  const allowedIds = new Set(state.permissions.filter(permission => ['reviewer','finance','subject_admin'].includes(permission.role) && permission.is_active).map(permission => permission.expense_subject_id));
  const scopedSubjects = state.profile?.is_platform_admin ? allSubjects : allSubjects.filter(subject => allowedIds.has(subject.id));
  state.subjects = scopedSubjects;
  try {
    _renderAdminScoped();
  } finally {
    state.subjects = allSubjects;
  }
};

// 通过现有 RLS 读取可见权限，再与受控人员目录合并，避免把权限范围交给前端猜测。
loadSession = async function(){
  state.message=null;
  const {data}=await supabase.auth.getSession();
  state.session=data.session;
  if(!state.session){renderLogin();return false;}
  const invite=invitationEmail();
  const signedInEmail=state.session.user.email?.trim().toLowerCase()||'';
  if(invite&&signedInEmail!==invite){
    await supabase.auth.signOut({scope:'local'});
    renderLogin(`当前浏览器已登录 ${signedInEmail||'其他 Google 账号'}，请切换到受邀的 ${invite}。`);
    return false;
  }
  try{await supabase.rpc('activate_user_access');}catch(error){console.error('activate_user_access',error);}
  const userId=state.session.user.id;
  const [profile,perms,subjects,claims,people,visiblePermissions]=await Promise.all([
    supabase.from('user_profile').select('*').eq('id',userId).maybeSingle(),
    supabase.from('user_subject_permission').select('*,expense_subject(*)').eq('user_id',userId).eq('is_active',true),
    supabase.from('expense_subject').select('*').order('subject_code'),
    supabase.from('reimbursement_claim').select('*,expense_subject(*),evidence_file(*)').order('updated_at',{ascending:false}),
    supabase.rpc('list_manageable_people'),
    supabase.from('user_subject_permission').select('*').eq('is_active',true)
  ]);
  state.profile=profile.data;
  state.permissions=perms.data||[];
  state.subjects=subjects.data||[];
  state.people=people.data||{users:[],invitations:[]};
  const visible=visiblePermissions.data||[];
  state.people.users=(state.people.users||[]).map(person=>({...person,permissions:visible.filter(permission=>permission.user_id===person.id)}));
  const knownPeople=state.people.users||[];
  state.claims=(claims.data||[]).map(claim=>({...claim,applicant:{display_name:knownPeople.find(person=>person.id===claim.applicant_user_id)?.short_name||knownPeople.find(person=>person.id===claim.applicant_user_id)?.full_name||knownPeople.find(person=>person.id===claim.applicant_user_id)?.display_name||knownPeople.find(person=>person.id===claim.applicant_user_id)?.email||'未知人员'}}));
  identity.innerHTML='<span>'+esc(state.profile?.short_name||state.profile?.display_name||state.session.user.email)+'</span> <button id="logout">退出</button>';
  document.querySelector('#logout')?.addEventListener('click',async()=>{await supabase.auth.signOut({scope:'local'});window.location.assign(invitationEmail()?invitationLoginUrl(invitationEmail()):applicationRootUrl());});
  return true;
};
loadSession().then(render);

// 主体编辑表单不显示示例占位文字，避免与实际字段值混淆。
const _renderSystemAdminWithoutSubjectExamples = renderSystemAdmin;
renderSystemAdmin = async function(){
  await _renderSystemAdminWithoutSubjectExamples();
  for (const fieldName of ['subject_code', 'display_name', 'short_name']) {
    document.querySelector('#subjectForm [name="' + fieldName + '"]')?.removeAttribute('placeholder');
  }
};
