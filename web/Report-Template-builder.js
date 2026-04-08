let templates={}, activeId=null, formVals={};
let acState={open:false,triggerPos:0,selectedIdx:0,items:[]};
let currentView='builder';
let persistTimer=null;
let serverConnected=false;
let serverTemplateDir='report-templates';
let pendingServerWarnings=[];
let addFieldDrafts={};
let dragFieldState=null;

const STORAGE_KEY='soc-report-builder.state.v3';
const THEME_KEY='soc-report-builder.theme';
const TEMPLATE_FILE_SUFFIX='.json';
const PREVIEW_WIDTH_KEY='soc-report-builder.fill-width';
const DEFAULT_FILL_WIDTH=420;
const MIN_FILL_WIDTH=300;
const MAX_FILL_WIDTH=900;
const STATE_API='/api/state';

const DEFAULT={'soc-default':{
  name:'SOC Incident Report',
  narrative:'We have found an alert being triggered with name {{Incident Overview.Incident ID}}.\n\nThe affected host {{Affected Assets.Hostname(s)}} (IP: {{Affected Assets.IP Address(es)}}) was involved in a {{Incident Overview.Incident Type}} incident classified as {{Incident Overview.Severity}} severity.\n\nDetected on {{Incident Overview.Date & Time}} by analyst {{Incident Overview.Analyst}}. Current status: {{Incident Overview.Status}}.\n\n## Summary\n\n{{Incident Description.Summary}}\n\n## Initial Vector\n\n{{Incident Description.Initial Vector}}\n\n## Indicators of Compromise\n\n**Hashes:** {{Indicators of Compromise.File Hashes}}\n**IPs/Domains:** {{Indicators of Compromise.Malicious IPs / Domains}}\n**MITRE TTPs:** {{Indicators of Compromise.MITRE ATT&CK TTPs}}\n\n## Remediation\n\n{{Containment & Remediation.Containment Actions}}\n\n## Root Cause\n\n{{Lessons Learned.Root Cause}}',
  sections:[
    {name:'Incident Overview',open:true,fields:[
      {label:'Incident ID',type:'text',placeholder:'INC-2024-XXXX'},
      {label:'Date & Time',type:'datetime-local',placeholder:''},
      {label:'Severity',type:'select',options:['Critical','High','Medium','Low','Informational']},
      {label:'Incident Type',type:'select',options:['Malware','Phishing','Unauthorized Access','DDoS','Data Exfiltration','Insider Threat','Other']},
      {label:'Status',type:'select',options:['Open','In Progress','Contained','Resolved','Closed']},
      {label:'Analyst',type:'text',placeholder:'Full name'},
    ]},
    {name:'Affected Assets',open:true,fields:[
      {label:'Hostname(s)',type:'text',placeholder:'e.g. DESKTOP-ABC123'},
      {label:'IP Address(es)',type:'text',placeholder:'192.168.1.x'},
      {label:'User Account(s)',type:'text',placeholder:'domain\\username'},
      {label:'Business Unit',type:'text',placeholder:''},
    ]},
    {name:'Incident Description',open:true,fields:[
      {label:'Summary',type:'textarea',placeholder:'Brief description...'},
      {label:'Initial Vector',type:'textarea',placeholder:'How did the attacker gain access?'},
      {label:'Timeline of Events',type:'textarea',placeholder:'Chronological log...'},
    ]},
    {name:'Indicators of Compromise',open:true,fields:[
      {label:'File Hashes',type:'textarea',placeholder:'MD5/SHA256 — one per line'},
      {label:'Malicious IPs / Domains',type:'textarea',placeholder:'One per line'},
      {label:'File Paths / Registry Keys',type:'textarea',placeholder:'One per line'},
      {label:'MITRE ATT&CK TTPs',type:'text',placeholder:'T1059.001, T1003.001'},
    ]},
    {name:'Containment & Remediation',open:true,fields:[
      {label:'Containment Actions',type:'textarea',placeholder:'Steps taken...'},
      {label:'Eradication Steps',type:'textarea',placeholder:'How was the threat removed?'},
      {label:'Recovery Actions',type:'textarea',placeholder:'Restore normal operations...'},
    ]},
    {name:'Lessons Learned',open:true,fields:[
      {label:'Root Cause',type:'textarea',placeholder:'Root cause...'},
      {label:'Recommendations',type:'textarea',placeholder:'Improvements...'},
      {label:'Additional Notes',type:'textarea',placeholder:''},
    ]},
  ]
}};

async function init(){
  applyStoredTheme();
  applyStoredPreviewWidth();
  await hydrateTemplates();
  const firstId=templates[activeId]?activeId:Object.keys(templates)[0];
  loadTemplate(firstId||'soc-default');
  setupAutocomplete();
  setupPreviewResize();
  renderTopbarActions(currentView);
}

function getStoredTheme(){
  const stored=localStorage.getItem(THEME_KEY);
  return stored==='dark'?'dark':'light';
}

function applyTheme(theme){
  document.documentElement.dataset.theme=theme;
  localStorage.setItem(THEME_KEY,theme);
}

function applyStoredTheme(){
  applyTheme(getStoredTheme());
}

function toggleTheme(){
  applyTheme(document.documentElement.dataset.theme==='dark'?'light':'dark');
  renderTopbarActions(currentView);
}

function slugifyTemplateName(name){
  return (name||'template')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g,'-')
    .replace(/^-+|-+$/g,'')
    || 'template';
}

function buildTemplateFileName(name,usedNames){
  const base=slugifyTemplateName(name);
  let candidate=`${base}${TEMPLATE_FILE_SUFFIX}`;
  let index=2;
  while(usedNames.has(candidate)){
    candidate=`${base}-${index}${TEMPLATE_FILE_SUFFIX}`;
    index+=1;
  }
  usedNames.add(candidate);
  return candidate;
}

function suggestFieldPlaceholder(label,type){
  const cleanLabel=(label||'').trim().toLowerCase();
  const compactLabel=cleanLabel.replace(/\(s\)/g,'s');

  if(type==='select')return '';
  if(type==='date')return 'dd / mm / yyyy';
  if(type==='datetime-local')return 'dd / mm / yyyy, --:--';

  const textPlaceholders=[
    [/incident id|case id|ticket id/, 'INC-2024-XXXX'],
    [/analyst|owner|assigned to/, 'Full name'],
    [/hostname|host name|device name/, 'e.g. DESKTOP-ABC123'],
    [/\bip address\b|\bips\b|\bip\b/, '192.168.1.x'],
    [/user account|username|account/, 'domain\\username'],
    [/business unit|department|team/, 'e.g. Finance'],
    [/title|name/, 'Short title'],
    [/status/, 'e.g. Open'],
    [/severity/, 'e.g. High'],
    [/mitre|ttp/, 'T1059.001, T1003.001'],
  ];

  const textareaPlaceholders=[
    [/summary|description/, 'Brief description...'],
    [/timeline/, 'Chronological log...'],
    [/root cause/, 'Root cause...'],
    [/recommendation/, 'Improvements...'],
    [/containment/, 'Steps taken...'],
    [/eradication/, 'How was the threat removed?'],
    [/recovery/, 'Restore normal operations...'],
    [/hash/, 'MD5/SHA256 - one per line'],
    [/domain|ip/, 'One per line'],
    [/path|registry/, 'One per line'],
    [/note/, 'Additional notes...'],
  ];

  const patterns=type==='textarea' ? textareaPlaceholders : textPlaceholders;
  const match=patterns.find(([pattern])=>pattern.test(compactLabel));
  return match ? match[1] : '';
}

function getAddFieldDraft(si){
  if(!addFieldDrafts[si]){
    addFieldDrafts[si]={type:'text',config:''};
  }
  return addFieldDrafts[si];
}

function getCurrentDateValue(type){
  const now=new Date();
  const pad=value=>String(value).padStart(2,'0');
  const year=now.getFullYear();
  const month=pad(now.getMonth()+1);
  const day=pad(now.getDate());
  if(type==='datetime-local'){
    return `${year}-${month}-${day}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
  }
  return `${year}-${month}-${day}`;
}

function syncAddFieldDraft(si){
  const labelEl=document.getElementById(`fl-${si}`);
  const typeEl=document.getElementById(`ft-${si}`);
  const configEl=document.getElementById(`fc-${si}`);
  const draft=getAddFieldDraft(si);
  if(labelEl)draft.label=labelEl.value;
  if(typeEl)draft.type=typeEl.value;
  if(configEl)draft.config=configEl.value;
}

function onAddFieldTypeChange(si){
  syncAddFieldDraft(si);
  const draft=getAddFieldDraft(si);
  if(draft.type==='date' || draft.type==='datetime-local'){
    draft.config=draft.config==='current' ? 'current' : 'manual';
  } else if(draft.type==='select'){
    draft.config='';
  } else {
    draft.config=draft.config || '';
  }
  renderAddFieldConfig(si);
}

function renderAddFieldConfig(si){
  const host=document.getElementById(`fc-wrap-${si}`);
  if(!host)return;
  const draft=getAddFieldDraft(si);

  if(draft.type==='select'){
    host.innerHTML=`<input type="text" id="fc-${si}" placeholder="Options (comma-sep)" style="flex:1;min-width:120px" value="${draft.config||''}" oninput="syncAddFieldDraft(${si})">`;
    return;
  }

  if(draft.type==='date' || draft.type==='datetime-local'){
    host.innerHTML=`<select id="fc-${si}" style="flex:1;min-width:140px" onchange="syncAddFieldDraft(${si})">
      <option value="manual"${draft.config==='current'?'':' selected'}>Manual entry</option>
      <option value="current"${draft.config==='current'?' selected':''}>Use current ${draft.type==='date'?'date':'date & time'}</option>
    </select>`;
    return;
  }

  host.innerHTML=`<input type="text" id="fc-${si}" placeholder="Placeholder (optional)" style="flex:1;min-width:120px" value="${draft.config||''}" oninput="syncAddFieldDraft(${si})">`;
}

function normalizeTemplate(id,template,usedNames){
  const normalized=JSON.parse(JSON.stringify(template));
  normalized.name=(normalized.name||'Untitled Template').trim()||'Untitled Template';
  normalized.narrative=normalized.narrative||'';
  normalized.sections=Array.isArray(normalized.sections)?normalized.sections:[];
  const preferredFileName=`${slugifyTemplateName(normalized.name)}${TEMPLATE_FILE_SUFFIX}`;
  normalized.fileName=usedNames.has(preferredFileName)
    ? buildTemplateFileName(normalized.name,usedNames)
    : (usedNames.add(preferredFileName),preferredFileName);
  return normalized;
}

function normalizeTemplateCollection(collection){
  const usedNames=new Set();
  const out={};
  Object.entries(collection||{}).forEach(([id,template])=>{
    if(template)out[id]=normalizeTemplate(id,template,usedNames);
  });
  return out;
}

function cloneDefault(){
  return normalizeTemplateCollection(JSON.parse(JSON.stringify(DEFAULT)));
}

function writeBrowserCache(){
  localStorage.setItem(STORAGE_KEY,JSON.stringify({templates,activeId}));
}

function readBrowserCache(){
  const raw=localStorage.getItem(STORAGE_KEY);
  if(!raw)return null;
  try{
    const state=JSON.parse(raw);
    if(state&&state.templates&&Object.keys(state.templates).length){
      return {
        templates:normalizeTemplateCollection(state.templates),
        activeId:state.activeId
      };
    }
  }catch(err){
    console.warn('Failed to load saved template state',err);
  }
  return null;
}

function applyTemplateState(state){
  templates=normalizeTemplateCollection(state.templates);
  activeId=state.activeId&&templates[state.activeId]?state.activeId:Object.keys(templates)[0];
  writeBrowserCache();
}

function queueServerWarnings(warnings){
  pendingServerWarnings=Array.isArray(warnings)?warnings.filter(Boolean):[];
}

function showQueuedServerWarnings(){
  if(!pendingServerWarnings.length)return;
  const count=pendingServerWarnings.length;
  const sample=pendingServerWarnings[0];
  pendingServerWarnings=[];
  toast(count===1?`Skipped invalid template file: ${sample}`:`Skipped ${count} invalid template files. First: ${sample}`);
}

async function fetchServerState(){
  const resp=await fetch(STATE_API,{headers:{Accept:'application/json'}});
  if(!resp.ok)throw new Error(`State load failed: ${resp.status}`);
  const data=await resp.json();
  serverConnected=true;
  serverTemplateDir=data.templateDir||serverTemplateDir;
  queueServerWarnings(data.warnings);
  if(data.templates&&Object.keys(data.templates).length){
    return {
      templates:data.templates,
      activeId:data.activeId,
      warnings:data.warnings
    };
  }
  return null;
}

async function hydrateTemplates(){
  templates=cloneDefault();
  activeId='soc-default';

  try{
    const state=await fetchServerState();
    if(state){
      applyTemplateState(state);
      showQueuedServerWarnings();
      return;
    }
  }catch(err){
    console.warn('Failed to load templates from Python server',err);
    serverConnected=false;
  }

  const state=readBrowserCache();
  if(state){
    templates=state.templates;
    activeId=state.activeId&&state.templates[state.activeId]?state.activeId:Object.keys(state.templates)[0];
  }
}

function loadTemplate(id){
  activeId=id;
  const t=templates[id];
  document.getElementById('tpl-name').value=t.name;
  document.getElementById('narrative-editor').value=t.narrative||'';
  renderBuilder();
  renderSidebar();
  updateMeta();
  renderVarChips();
  if(currentView==='fill')renderFillForm();
  renderTopbarActions(currentView);
}

function renderSidebar(){
  const el=document.getElementById('tpl-list');
  el.innerHTML='';
  Object.keys(templates).forEach(id=>{
    const d=document.createElement('div');
    d.className='tpl-row'+(activeId===id?' active':'');
    d.innerHTML=`<span class="tpl-icon">📋</span><span class="tpl-name" onclick="loadTemplate('${id}')">${templates[id].name}</span><button class="tpl-del" onclick="delTpl('${id}')">×</button>`;
    el.appendChild(d);
  });
}

function updateMeta(){
  if(!activeId)return;
  const t=templates[activeId];
  const fc=t.sections.reduce((a,s)=>a+s.fields.length,0);
  document.getElementById('tpl-meta').textContent=`${t.sections.length} sections · ${fc} fields`;
}

function getAllVars(){
  if(!activeId)return[];
  const vars=[];
  templates[activeId].sections.forEach(sec=>{
    sec.fields.forEach(f=>{vars.push({section:sec.name,label:f.label,key:`${sec.name}.${f.label}`});});
  });
  return vars;
}

function renderVarChips(){
  const el=document.getElementById('var-chips');
  el.innerHTML=getAllVars().map(v=>`<span class="var-chip" title="Click to copy" onclick="copyVar('{{${v.key}}}')">{{${v.key}}}</span>`).join('');
}

function copyVar(v){navigator.clipboard.writeText(v).then(()=>toast('Copied'));}

function moveField(sectionIndex,fromIndex,toIndex){
  const fields=templates[activeId]?.sections?.[sectionIndex]?.fields;
  if(!fields || fromIndex===toIndex || fromIndex<0 || toIndex<0 || fromIndex>=fields.length || toIndex>=fields.length){
    return;
  }
  const [field]=fields.splice(fromIndex,1);
  fields.splice(toIndex,0,field);
  renderBuilder();
  updateMeta();
  renderVarChips();
  scheduleTemplatePersist();
}

function handleFieldDragStart(sectionIndex,fieldIndex,event){
  dragFieldState={sectionIndex,fieldIndex};
  event.dataTransfer.effectAllowed='move';
  event.dataTransfer.setData('text/plain',`${sectionIndex}:${fieldIndex}`);
  event.currentTarget.classList.add('dragging');
}

function handleFieldDragOver(sectionIndex,fieldIndex,event){
  if(!dragFieldState || dragFieldState.sectionIndex!==sectionIndex || dragFieldState.fieldIndex===fieldIndex){
    return;
  }
  event.preventDefault();
  event.dataTransfer.dropEffect='move';
  const rows=document.querySelectorAll(`.field-row[data-section-index="${sectionIndex}"]`);
  rows.forEach(row=>row.classList.remove('drop-target'));
  event.currentTarget.classList.add('drop-target');
}

function handleFieldDrop(sectionIndex,fieldIndex,event){
  if(!dragFieldState || dragFieldState.sectionIndex!==sectionIndex){
    return;
  }
  event.preventDefault();
  const fromIndex=dragFieldState.fieldIndex;
  const rows=document.querySelectorAll(`.field-row[data-section-index="${sectionIndex}"]`);
  rows.forEach(row=>row.classList.remove('drop-target'));
  event.currentTarget.classList.remove('drop-target');
  if(fromIndex!==fieldIndex){
    moveField(sectionIndex,fromIndex,fieldIndex);
  }
  dragFieldState=null;
}

function handleFieldDragEnd(event){
  document.querySelectorAll('.field-row').forEach(row=>{
    row.classList.remove('dragging');
    row.classList.remove('drop-target');
  });
  event.currentTarget.classList.remove('dragging');
  dragFieldState=null;
}

function getFieldConfigSummary(field){
  if(field.type==='select'){
    const options=Array.isArray(field.options)?field.options.filter(Boolean):[];
    return options.length ? `Options: ${options.join(', ')}` : 'Options: none';
  }
  if(field.type==='date' || field.type==='datetime-local'){
    return field.dateMode==='current' ? 'Default: current date/time' : 'Default: manual entry';
  }
  return field.placeholder ? `Placeholder: ${field.placeholder}` : 'Placeholder: none';
}

function renderBuilder(){
  const t=templates[activeId];
  const c=document.getElementById('sections-container');
  c.innerHTML='';
  t.sections.forEach((sec,si)=>{
    const wrap=document.createElement('div');
    wrap.className='section-block';
    const body=sec.fields.map((f,fi)=>`
      <div class="field-row" draggable="true" data-section-index="${si}" data-field-index="${fi}" ondragstart="handleFieldDragStart(${si},${fi},event)" ondragover="handleFieldDragOver(${si},${fi},event)" ondrop="handleFieldDrop(${si},${fi},event)" ondragend="handleFieldDragEnd(event)">
        <span class="field-drag">⠿</span>
        <span class="field-label-text">${f.label}</span>
        <span class="field-type-badge">${f.type}</span>
        <span class="field-config-text" title="${getFieldConfigSummary(f).replace(/"/g,'&quot;')}">${getFieldConfigSummary(f)}</span>
        <button class="field-remove" onclick="removeField(${si},${fi})">×</button>
      </div>`).join('');
    wrap.innerHTML=`
      <div class="section-header" onclick="toggleSection(${si},event)">
        <span class="section-toggle ${sec.open?'open':''}">▶</span>
        <input class="section-name-input" value="${sec.name}" onclick="event.stopPropagation()" oninput="templates[activeId].sections[${si}].name=this.value;updateMeta();renderVarChips();scheduleTemplatePersist()">
        <button class="section-remove" onclick="event.stopPropagation();removeSection(${si})">Delete</button>
      </div>
      <div class="section-body" style="display:${sec.open?'block':'none'}">
        ${body}
        <div class="add-field-row">
          <input type="text" id="fl-${si}" placeholder="Field label" style="flex:1;min-width:120px" value="${getAddFieldDraft(si).label||''}" oninput="syncAddFieldDraft(${si})" onkeydown="if(event.key==='Enter')addField(${si})">
          <select id="ft-${si}" style="width:105px" onchange="onAddFieldTypeChange(${si})">
            <option value="text">Text</option><option value="textarea">Textarea</option>
            <option value="date">Date</option><option value="datetime-local">Date+Time</option>
            <option value="select">Select</option>
          </select>
          <div id="fc-wrap-${si}" style="display:flex;flex:1;min-width:120px"></div>
          <button class="btn btn-ghost" style="font-size:12px;white-space:nowrap" onclick="addField(${si})">+ Add</button>
        </div>
      </div>`;
    c.appendChild(wrap);
    const typeEl=document.getElementById(`ft-${si}`);
    typeEl.value=getAddFieldDraft(si).type||'text';
    renderAddFieldConfig(si);
  });
}

function toggleSection(si,e){
  if(e.target.tagName==='INPUT'||e.target.tagName==='BUTTON')return;
  templates[activeId].sections[si].open=!templates[activeId].sections[si].open;
  renderBuilder();
  scheduleTemplatePersist();
}

function removeSection(si){
  templates[activeId].sections.splice(si,1);
  renderBuilder();
  updateMeta();
  renderVarChips();
  scheduleTemplatePersist();
}

function removeField(si,fi){
  templates[activeId].sections[si].fields.splice(fi,1);
  renderBuilder();
  updateMeta();
  renderVarChips();
  scheduleTemplatePersist();
}

function addSection(){
  const inp=document.getElementById('new-section-input');
  const name=inp.value.trim();
  if(!name)return;
  templates[activeId].sections.push({name,open:true,fields:[]});
  inp.value='';
  renderBuilder();
  updateMeta();
  renderVarChips();
  scheduleTemplatePersist();
}

function addField(si){
  syncAddFieldDraft(si);
  const draft=getAddFieldDraft(si);
  const label=(draft.label||'').trim();
  if(!label)return;
  const type=draft.type||'text';
  const config=(draft.config||'').trim();
  const f={label,type,placeholder:suggestFieldPlaceholder(label,type)};
  if(type==='select'){
    f.options=config?config.split(',').map(s=>s.trim()).filter(Boolean):['Option 1','Option 2'];
  } else if(type==='date' || type==='datetime-local'){
    f.dateMode=config==='current' ? 'current' : 'manual';
  } else if(config){
    f.placeholder=config;
  }
  templates[activeId].sections[si].fields.push(f);
  addFieldDrafts[si]={type:'text',label:'',config:''};
  renderBuilder();
  updateMeta();
  renderVarChips();
  scheduleTemplatePersist();
}

async function saveTemplate(){
  if(!activeId)return;
  templates[activeId].name=document.getElementById('tpl-name').value.trim()||'Untitled';
  templates[activeId].narrative=document.getElementById('narrative-editor').value;
  renderSidebar();
  renderTopbarActions(currentView);
  const saved=await persistTemplates(true);
  toast(saved?'Saved to Python template folder':'Save failed, kept browser copy only');
}

function newTemplate(){
  const id='tpl-'+Date.now();
  templates[id]={name:'New Template',narrative:'',sections:[{name:'Overview',open:true,fields:[
    {label:'Title',type:'text',placeholder:suggestFieldPlaceholder('Title','text')},
    {label:'Date',type:'date',placeholder:suggestFieldPlaceholder('Date','date')},
    {label:'Status',type:'select',options:['Open','In Progress','Closed']},
    {label:'Description',type:'textarea',placeholder:suggestFieldPlaceholder('Description','textarea')},
  ]}],fileName:null};
  loadTemplate(id);
  scheduleTemplatePersist();
}

function delTpl(id){
  if(Object.keys(templates).length<=1){toast('Cannot delete last template');return;}
  delete templates[id];
  if(activeId===id)loadTemplate(Object.keys(templates)[0]);
  else renderSidebar();
  scheduleTemplatePersist();
}

function setupAutocomplete(){
  const ed=document.getElementById('narrative-editor');
  const dd=document.getElementById('ac-dropdown');
  ed.addEventListener('input',()=>{
    templates[activeId].narrative=ed.value;
    const pos=ed.selectionStart;
    const text=ed.value.substring(0,pos);
    const match=text.match(/\{\{([^}]*)$/);
    if(match){
      const q=match[1].toLowerCase();
      const vars=getAllVars();
      const filtered=vars.filter(v=>v.key.toLowerCase().includes(q)||v.label.toLowerCase().includes(q)||v.section.toLowerCase().includes(q));
      if(filtered.length){
        acState={open:true,triggerPos:pos-match[0].length,selectedIdx:0,items:filtered};
        renderDropdown(ed,dd,filtered,q);
      } else closeAC(dd);
    } else closeAC(dd);
  });
  ed.addEventListener('keydown',e=>{
    if(!acState.open)return;
    if(e.key==='ArrowDown'){e.preventDefault();acState.selectedIdx=Math.min(acState.selectedIdx+1,acState.items.length-1);highlightAC(dd);}
    else if(e.key==='ArrowUp'){e.preventDefault();acState.selectedIdx=Math.max(acState.selectedIdx-1,0);highlightAC(dd);}
    else if(e.key==='Enter'||e.key==='Tab'){e.preventDefault();insertVar(ed,dd,acState.items[acState.selectedIdx]);}
    else if(e.key==='Escape')closeAC(dd);
  });
  document.addEventListener('click',e=>{if(!dd.contains(e.target)&&e.target!==ed)closeAC(dd);});
}

function renderDropdown(ed,dd,items,q){
  const r=ed.getBoundingClientRect();
  dd.style.left=(r.left+10)+'px';
  dd.style.top=(r.bottom-40)+'px';
  dd.style.display='block';
  let lastSec='';
  dd.innerHTML=items.map((v,i)=>{
    let h='';
    if(v.section!==lastSec){h+=`<div class="ac-section-label">${v.section}</div>`;lastSec=v.section;}
    const lq=q.split('.').pop();
    const hl=lq?v.label.replace(new RegExp(`(${lq.replace(/[.*+?^${}()|[\\]\\]/g,'\\$&')})`, 'gi'),'<strong>$1</strong>'):v.label;
    h+=`<div class="ac-item${i===acState.selectedIdx?' selected':''}" onmousedown="event.preventDefault();insertVarIdx(${i})"><span>${hl}</span><span class="ac-item-key">${v.key}</span></div>`;
    return h;
  }).join('');
}

function insertVarIdx(i){
  const ed=document.getElementById('narrative-editor');
  const dd=document.getElementById('ac-dropdown');
  insertVar(ed,dd,acState.items[i]);
}

function highlightAC(dd){
  dd.querySelectorAll('.ac-item').forEach((el,i)=>{
    el.classList.toggle('selected',i===acState.selectedIdx);
    if(i===acState.selectedIdx)el.scrollIntoView({block:'nearest'});
  });
}

function insertVar(ed,dd,v){
  if(!v)return;
  const before=ed.value.substring(0,acState.triggerPos);
  const after=ed.value.substring(ed.selectionStart);
  const ins=`{{${v.key}}}`;
  ed.value=before+ins+after;
  const np=before.length+ins.length;
  ed.setSelectionRange(np,np);
  ed.focus();
  templates[activeId].narrative=ed.value;
  closeAC(dd);
}

function closeAC(dd){
  dd.style.display='none';
  acState.open=false;
}

function renderFillForm(){
  if(!activeId){
    document.getElementById('fill-form').innerHTML='';
    return;
  }
  const t=templates[activeId];
  document.getElementById('fill-col-title').textContent=t.name;
  formVals={};
  const container=document.getElementById('fill-form');
  container.innerHTML='';

  t.sections.forEach((sec,si)=>{
    if(!sec.fields.length)return;
    const lbl=document.createElement('div');
    lbl.className='section-fill-label';
    lbl.textContent=sec.name.toUpperCase();
    container.appendChild(lbl);

    const tbl=document.createElement('table');
    tbl.className='props-table';

    sec.fields.forEach((f,fi)=>{
      const k=`${si}_${fi}`;
      const tr=document.createElement('tr');
      tr.className='prop-row';

      const icon=f.type==='select'?'🏷️':f.type==='textarea'?'📝':f.type.includes('date')?'📅':'📌';
      const tdKey=document.createElement('td');
      tdKey.className='prop-key';
      tdKey.innerHTML=`<span style="font-size:12px">${icon}</span>${f.label}`;

      const tdVal=document.createElement('td');
      tdVal.className='prop-val';

      let inp;
      if(f.type==='select'){
        inp=document.createElement('select');
        const empty=document.createElement('option');
        empty.value='';
        empty.textContent='Empty';
        inp.appendChild(empty);
        (f.options||[]).forEach(o=>{
          const opt=document.createElement('option');
          opt.value=o;
          opt.textContent=o;
          inp.appendChild(opt);
        });
        inp.addEventListener('change',()=>{formVals[k]=inp.value;updatePreview();});
      } else if((f.type==='date' || f.type==='datetime-local') && f.dateMode==='current'){
        inp=document.createElement('input');
        inp.type=f.type;
        inp.value=getCurrentDateValue(f.type);
        inp.disabled=true;
        formVals[k]=inp.value;
      } else if(f.type==='textarea'){
        inp=document.createElement('textarea');
        inp.rows=3;
        inp.placeholder=f.placeholder||'';
        inp.addEventListener('input',()=>{formVals[k]=inp.value;updatePreview();});
      } else {
        inp=document.createElement('input');
        inp.type=f.type;
        inp.placeholder=f.placeholder||'';
        inp.addEventListener('input',()=>{formVals[k]=inp.value;updatePreview();});
      }

      tdVal.appendChild(inp);
      tr.appendChild(tdKey);
      tr.appendChild(tdVal);
      tbl.appendChild(tr);
    });

    container.appendChild(tbl);
  });

  updatePreview();
}

function getValMap(){
  if(!activeId)return{};
  const map={};
  templates[activeId].sections.forEach((sec,si)=>{
    sec.fields.forEach((f,fi)=>{map[`${sec.name}.${f.label}`]=(formVals[`${si}_${fi}`]||'').trim();});
  });
  return map;
}

function resolveNarrative(raw,map,html=false){
  return raw.replace(/\{\{([^}]+)\}\}/g,(match,key)=>{
    const val=map[key.trim()];
    if(html)return val?`<span class="var-filled">${escHtml(val)}</span>`:`<span class="var-empty">{{${key.trim()}}}</span>`;
    return val||`[${key.trim()}]`;
  });
}

function escHtml(s){return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}

function updatePreview(){
  const t=templates[activeId];
  if(!t)return;
  const map=getValMap();
  const raw=t.narrative||'';
  if(!raw.trim()){
    document.getElementById('preview-prose').innerHTML='<span style="color:var(--text3);font-style:italic">No narrative defined. Add one in Template Builder.</span>';
    return;
  }
  const htmlNarr=resolveNarrative(raw,map,true);
  document.getElementById('preview-prose').innerHTML=htmlNarr.replace(/\n/g,'<br>');
}

function buildMd(){
  const map=getValMap();
  return resolveNarrative((templates[activeId]?.narrative)||'',map,false).trim();
}

function copyMd(){
  navigator.clipboard.writeText(buildMd()).then(()=>{
    const b=document.getElementById('copy-btn');
    b.textContent='Copied!';
    setTimeout(()=>b.textContent='Copy Markdown',2000);
  });
}

function printReport(){
  const t=templates[activeId];
  const md=buildMd();
  const win=window.open('','_blank');
  const body=md
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/^# (.+)$/gm,'<h1>$1</h1>')
    .replace(/^## (.+)$/gm,'<h2>$1</h2>')
    .replace(/^### (.+)$/gm,'<h3>$1</h3>')
    .replace(/^&gt; (.+)$/gm,'<blockquote>$1</blockquote>')
    .replace(/^---$/gm,'<hr>')
    .replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>')
    .replace(/\[(.+?)\]/g,'<span style="background:#fbe4e4;color:#e03e3e;padding:0 2px;border-radius:3px">[$1]</span>')
    .replace(/\n/g,'<br>');
  win.document.write(`<!DOCTYPE html><html><head><title>${escHtml(t.name)}</title>
  <style>body{font-family:-apple-system,sans-serif;max-width:800px;margin:40px auto;padding:0 40px;color:#37352f;font-size:14px;line-height:1.7}
  h1{font-size:26px;margin-bottom:4px}h2{font-size:17px;margin-top:24px}h3{font-size:14px;color:#787672;margin-top:14px}
  blockquote{border-left:3px solid #e9e9e7;margin:0;padding:4px 12px;color:#787672}hr{border:none;border-top:1px solid #e9e9e7;margin:18px 0}
  </style></head><body>${body}</body></html>`);
  win.document.close();
  setTimeout(()=>win.print(),300);
}

function switchView(v){
  currentView=v;
  ['builder','fill'].forEach(x=>{
    document.getElementById('nav-'+x)?.classList.toggle('active',x===v);
    const p=document.getElementById('panel-'+x);
    if(p){
      p.style.display=x===v?'flex':'none';
      p.classList.toggle('visible',x===v);
    }
  });
  const titles={builder:'Template Builder',fill:'Fill & Preview'};
  document.getElementById('breadcrumb-title').textContent=titles[v]||v;
  if(v==='fill')renderFillForm();
  renderTopbarActions(v);
}

function toast(msg){
  const el=document.getElementById('toast');
  el.textContent=msg;
  el.classList.add('show');
  setTimeout(()=>el.classList.remove('show'),2000);
}

function renderTopbarActions(view){
  const acts=document.getElementById('topbar-actions');
  const reloadLabel=serverConnected?`Reload ${serverTemplateDir}`:'Reload Templates';
  const themeMode=document.documentElement.dataset.theme==='dark'?'dark':'light';
  const themeSwitch=`<button class="btn btn-ghost theme-toggle" data-mode="${themeMode}" onclick="toggleTheme()" aria-label="Toggle color theme" title="Toggle light and dark mode"><span class="theme-toggle-track"><span class="theme-toggle-thumb"></span><span class="theme-toggle-icon theme-icon-light" aria-hidden="true"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"></circle><path d="M12 2v2"></path><path d="M12 20v2"></path><path d="m4.93 4.93 1.41 1.41"></path><path d="m17.66 17.66 1.41 1.41"></path><path d="M2 12h2"></path><path d="M20 12h2"></path><path d="m6.34 17.66-1.41 1.41"></path><path d="m19.07 4.93-1.41 1.41"></path></svg></span><span class="theme-toggle-icon theme-icon-dark" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M21 12.79A9 9 0 1 1 11.21 3c0 5.02 4.07 9.09 9.09 9.79Z"></path></svg></span></span></button>`;
  if(view==='builder'){
    acts.innerHTML=`${themeSwitch}<button class="btn btn-ghost workspace-btn" title="Reload templates from the Python server folder" onclick="reloadTemplatesFromServer()">${reloadLabel}</button><button class="btn btn-blue" onclick="saveTemplate()">Save template</button>`;
  } else {
    acts.innerHTML=`<button class="btn btn-ghost" onclick="switchView('builder')">← Builder</button>${themeSwitch}<button class="btn btn-ghost workspace-btn" title="Reload templates from the Python server folder" onclick="reloadTemplatesFromServer()">${reloadLabel}</button>`;
  }
}

function scheduleTemplatePersist(){
  window.clearTimeout(persistTimer);
  persistTimer=window.setTimeout(()=>{persistTemplates(false);},500);
}

async function persistTemplates(showToast){
  writeBrowserCache();
  const saved=await saveTemplatesToServer();
  if(showToast&&!saved){
    toast('Could not write template JSON files, kept a browser copy instead');
  }
  return saved;
}

async function reloadTemplatesFromServer(showToast=true){
  try{
    const state=await fetchServerState();
    if(state){
      applyTemplateState(state);
      loadTemplate(activeId);
      if(currentView==='fill')renderFillForm();
      if(showToast&&!pendingServerWarnings.length)toast(`Reloaded templates from ${serverTemplateDir}`);
      showQueuedServerWarnings();
      return true;
    }
  }catch(err){
    console.warn('Failed to reload templates from Python server',err);
    serverConnected=false;
    renderTopbarActions(currentView);
    if(showToast)toast('Could not reach the Python server');
  }
  return false;
}

async function saveTemplatesToServer(){
  try{
    const resp=await fetch(STATE_API,{
      method:'POST',
      headers:{'Content-Type':'application/json',Accept:'application/json'},
      body:JSON.stringify({templates,activeId})
    });
    if(!resp.ok)throw new Error(`State save failed: ${resp.status}`);
    const data=await resp.json();
    serverConnected=true;
    serverTemplateDir=data.templateDir||serverTemplateDir;
    queueServerWarnings(data.warnings);
    if(data.templates&&Object.keys(data.templates).length){
      applyTemplateState({templates:data.templates,activeId:data.activeId});
      renderSidebar();
      updateMeta();
      renderVarChips();
      renderTopbarActions(currentView);
      showQueuedServerWarnings();
    }
    return true;
  }catch(err){
    console.warn('Unable to save templates to Python server',err);
    serverConnected=false;
    renderTopbarActions(currentView);
    return false;
  }
}

function applyStoredPreviewWidth(){
  const raw=localStorage.getItem(PREVIEW_WIDTH_KEY);
  const width=Math.min(MAX_FILL_WIDTH,Math.max(MIN_FILL_WIDTH,Number(raw)||DEFAULT_FILL_WIDTH));
  document.documentElement.style.setProperty('--fill-width',width+'px');
}

function setupPreviewResize(){
  const resizer=document.getElementById('preview-resizer');
  const wrap=document.querySelector('.fill-preview-wrap');
  resizer.addEventListener('mousedown',event=>{
    event.preventDefault();
    const startX=event.clientX;
    const startWidth=document.querySelector('.fill-col').getBoundingClientRect().width;
    resizer.classList.add('dragging');

    const onMove=moveEvent=>{
      const bounds=wrap.getBoundingClientRect();
      const nextWidth=Math.min(
        Math.max(startWidth+(moveEvent.clientX-startX),MIN_FILL_WIDTH),
        Math.min(MAX_FILL_WIDTH,bounds.width-320)
      );
      document.documentElement.style.setProperty('--fill-width',nextWidth+'px');
      localStorage.setItem(PREVIEW_WIDTH_KEY,String(Math.round(nextWidth)));
    };

    const onUp=()=>{
      resizer.classList.remove('dragging');
      window.removeEventListener('mousemove',onMove);
      window.removeEventListener('mouseup',onUp);
    };

    window.addEventListener('mousemove',onMove);
    window.addEventListener('mouseup',onUp);
  });
}

init();
document.getElementById('tpl-name').addEventListener('input',e=>{
  if(!activeId)return;
  templates[activeId].name=e.target.value;
  renderSidebar();
  renderTopbarActions(currentView);
  scheduleTemplatePersist();
});
document.getElementById('narrative-editor').addEventListener('input',e=>{
  if(!activeId)return;
  templates[activeId].narrative=e.target.value;
  scheduleTemplatePersist();
});
