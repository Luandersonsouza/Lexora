// Configuração do Supabase
const SUPABASE_URL = 'https://iocigkighyffefmomthq.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlvY2lna2lnaHlmZmVmbW9tdGhxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU1Mzc1NTEsImV4cCI6MjEwMTExMzU1MX0.POnC8Yfb4I6WSUgDXX30yK1rVTQUYkuOqczJSnW--i0';

// Inicializar Supabase - Versão compatível com CDN
let supabaseClient;

try {
  // Tentar diferentes formas de inicializar
  if (window.supabase && typeof window.supabase.createClient === 'function') {
    supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    console.log('✅ Supabase inicializado via createClient');
  } else if (window.supabase && window.supabase.default) {
    supabaseClient = window.supabase.default.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    console.log('✅ Supabase inicializado via default.createClient');
  } else {
    // Fallback: criar manualmente
    console.error('❌ Não foi possível inicializar Supabase');
    console.log('Estrutura do window.supabase:', window.supabase);
  }
} catch (error) {
  console.error('❌ Erro ao inicializar Supabase:', error);
}

// Resto do código permanece igual...
// [Mantenha TODO o resto do seu app.js a partir da linha 46 em diante]

const loginView = document.querySelector('#login-view');
const appView = document.querySelector('#app-view');
const loginForm = document.querySelector('#login-form');
const loginError = document.querySelector('#login-error');
const pageTitles = { pesquisa: 'Nova pesquisa', historico: 'Historico', salvos: 'Salvos', configuracoes: 'Configuracoes' };
let researches = [];
let currentProfile = null;

function renderIcons() {
  window.lucide?.createIcons({ attrs: { 'stroke-width': 1.8 } });
}

function escapeHtml(value) {
  return String(value || '').replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  }[character]));
}

function safeResultUrl(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : '#';
  } catch (_) {
    return '#';
  }
}

// ============ NOVAS FUNÇÕES SUPABASE ============

async function getSupabaseSession() {
  const { data: { session }, error } = await supabaseClient.auth.getSession();
  if (error) {
    console.error('Erro ao obter sessão:', error);
    return null;
  }
  return session;
}

async function authenticateWithSupabase(email, password) {
  console.log('🔐 Tentando login com:', email);
  
  const { data, error } = await supabaseClient.auth.signInWithPassword({
    email: email,
    password: password
  });
  
  if (error) {
    console.error('❌ Erro no login:', error);
    throw error;
  }
  
  console.log('✅ Login bem-sucedido:', data);
  return data;
}

async function logoutFromSupabase() {
  const { error } = await supabaseClient.auth.signOut();
  if (error) {
    console.error('Erro ao fazer logout:', error);
    throw error;
  }
}

async function loadProfileFromSupabase() {
  const { data: { user }, error: userError } = await supabaseClient.auth.getUser();
  
  if (userError || !user) {
    console.error('Erro ao obter usuário:', userError);
    return null;
  }
  
  console.log('👤 Usuário autenticado:', user.id);
  
  // Buscar dados do perfil na tabela profiles
  const { data: profile, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('user_id', user.id)
    .single();
  
  if (error && error.code !== 'PGRST116') {
    console.error('Erro ao carregar perfil:', error);
    return null;
  }
  
  // Se não existe perfil, criar um básico
  if (!profile) {
    console.log('📝 Criando novo perfil...');
    const newProfile = {
      user_id: user.id,
      name: user.email ? user.email.split('@')[0] : 'Usuário',
      email: user.email,
      role: 'user'
    };
    
    const { data: createdProfile, error: createError } = await supabase
      .from('profiles')
      .insert([newProfile])
      .select()
      .single();
    
    if (createError) {
      console.error('Erro ao criar perfil:', createError);
      return null;
    }
    
    console.log('✅ Perfil criado:', createdProfile);
    return createdProfile;
  }
  
  return profile;
}

async function updateProfileInSupabase(profileData) {
  const { data: { user } } = await supabaseClient.auth.getUser();
  if (!user) throw new Error('Usuário não autenticado');
  
  const { data, error } = await supabase
    .from('profiles')
    .update(profileData)
    .eq('user_id', user.id)
    .select()
    .single();
  
  if (error) throw error;
  return data;
}

async function loadResearchesFromSupabase() {
  const { data: { user } } = await supabaseClient.auth.getUser();
  if (!user) return [];
  
  const { data, error } = await supabase
    .from('research_requests')
    .select('*')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false });
  
  if (error) {
    console.error('Erro ao carregar pesquisas:', error);
    return [];
  }
  
  // Transformar para o formato usado na UI
  return (data || []).map(research => ({
    id: research.id,
    fullName: research.full_name || '',
    documentId: research.document_id || '',
    source: research.source || '',
    status: research.status,
    results: research.results || [],
    resultCount: research.result_count || 0,
    errorMessage: research.error_message || '',
    createdAt: research.created_at,
    isSaved: research.is_saved || false
  }));
}

async function createResearchInSupabase(researchData) {
  const { data: { user } } = await supabaseClient.auth.getUser();
  if (!user) throw new Error('Usuário não autenticado');
  
  const { data, error } = await supabase
    .from('research_requests')
    .insert([{
      user_id: user.id,
      full_name: researchData.fullName,
      document_id: researchData.documentId,
      source: researchData.source,
      state: researchData.state,
      keyword: researchData.keyword,
      status: 'queued'
    }])
    .select()
    .single();
  
  if (error) throw error;
  
  return {
    id: data.id,
    fullName: data.full_name,
    documentId: data.document_id,
    source: data.source,
    status: data.status,
    results: [],
    resultCount: 0,
    createdAt: data.created_at,
    isSaved: false
  };
}

async function toggleSaveResearchInSupabase(researchId, saved) {
  const { error } = await supabase
    .from('research_requests')
    .update({ is_saved: saved })
    .eq('id', researchId);
  
  if (error) throw error;
}

// ============ FUNÇÕES DE UI ============

function getActiveView() {
  const view = window.location.hash.slice(1);
  return pageTitles[view] ? view : 'pesquisa';
}

function setView(view) {
  const target = pageTitles[view] ? view : 'pesquisa';
  document.querySelectorAll('.app-view-panel').forEach((panel) => { panel.hidden = panel.id !== target; });
  document.querySelectorAll('[data-view-link]').forEach((link) => link.classList.toggle('active', link.dataset.viewLink === target));
  document.querySelector('#page-title').textContent = pageTitles[target];
  if (window.location.hash !== `#${target}`) window.location.hash = target;
  renderAllResearches();
  if (target === 'configuracoes') loadProfile();
}

async function showApp() {
  console.log('📱 Mostrando aplicação...');
  loginView.hidden = true;
  appView.hidden = false;
  setView(getActiveView());
  renderIcons();
  await loadProfile();
  await loadResearches();
}

function showLogin() {
  console.log('🔒 Mostrando login...');
  appView.hidden = true;
  loginView.hidden = false;
  renderIcons();
}

function renderProfile(profile) {
  if (!profile) return;
  currentProfile = profile;
  document.querySelectorAll('[data-profile-name]').forEach((node) => { node.textContent = profile.name; });
  document.querySelectorAll('[data-profile-role]').forEach((node) => { node.textContent = profile.role; });
  
  const profileNameInput = document.querySelector('#profile-name');
  const profileEmailInput = document.querySelector('#profile-email');
  const profileRoleInput = document.querySelector('#profile-role');
  
  if (profileNameInput) profileNameInput.value = profile.name || '';
  if (profileEmailInput) profileEmailInput.value = profile.email || '';
  if (profileRoleInput) profileRoleInput.value = profile.role || 'user';
}

async function loadProfile() {
  try {
    const profile = await loadProfileFromSupabase();
    if (profile) renderProfile(profile);
  } catch (error) {
    console.error('Erro ao carregar perfil:', error);
  }
}

function statusLabel(status) {
  return ({ queued: 'Na fila', running: 'Em andamento', completed: 'Concluida', failed: 'Falhou' }[status] || status);
}

function renderSearchFeedback() {
  const feedback = document.querySelector('#search-feedback');
  const latest = researches[0];
  if (!latest) {
    feedback.className = 'empty-state';
    feedback.innerHTML = '<i data-lucide="inbox"></i><p>Nenhuma pesquisa em andamento.</p><span>As solicitacoes enviadas aparecerao aqui.</span>';
    return;
  }
  const states = {
    queued: ['clock-3', 'Pesquisa aguardando processamento.'],
    running: ['loader-circle', 'Pesquisa em andamento no Google.'],
    completed: ['circle-check', `Pesquisa concluida: ${latest.resultCount} resultado(s) encontrado(s).`],
    failed: ['circle-alert', 'A pesquisa nao pode ser concluida.'],
  };
  const [icon, message] = states[latest.status] || states.queued;
  const results = latest.status === 'completed' && latest.results.length
    ? `<ul class="result-list">${latest.results.map((result) => `<li><a href="${escapeHtml(safeResultUrl(result.url))}" target="_blank" rel="noopener noreferrer">${escapeHtml(result.title)} <i data-lucide="external-link"></i></a></li>`).join('')}</ul>` : '';
  const details = latest.status === 'failed' ? latest.errorMessage : `${latest.fullName} &middot; ${latest.source}`;
  feedback.className = 'empty-state job-state';
  feedback.innerHTML = `<i data-lucide="${icon}"></i><div><p>Pesquisa #${latest.id}: ${message}</p><span>${escapeHtml(details)}</span>${results}</div>`;
}

function researchRow(research) {
  const subject = research.fullName || research.documentId || 'Sem identificacao';
  const date = new Date(research.createdAt).toLocaleString('pt-BR');
  return `<article class="research-row"><div class="research-main"><strong>${escapeHtml(subject)}</strong><span>${escapeHtml(research.source)} &middot; ${date}</span></div><span class="status status-${escapeHtml(research.status)}">${statusLabel(research.status)}</span><button class="save-button ${research.isSaved ? 'saved' : ''}" type="button" data-save-id="${research.id}" data-saved="${research.isSaved}" aria-label="${research.isSaved ? 'Remover dos salvos' : 'Salvar pesquisa'}" title="${research.isSaved ? 'Remover dos salvos' : 'Salvar pesquisa'}"><i data-lucide="bookmark"></i></button></article>`;
}

function renderResearchList(element, items, emptyMessage) {
  if (!element) return;
  element.innerHTML = items.length ? items.map(researchRow).join('') : `<div class="list-empty"><i data-lucide="inbox"></i><p>${emptyMessage}</p></div>`;
}

function renderAllResearches() {
  renderSearchFeedback();
  renderResearchList(document.querySelector('#history-list'), researches, 'Nenhuma pesquisa registrada ainda.');
  renderResearchList(document.querySelector('#saved-list'), researches.filter((research) => research.isSaved), 'Nenhuma pesquisa salva ainda.');
  const historyCount = document.querySelector('#history-count');
  if (historyCount) {
    historyCount.textContent = `${researches.length} pesquisa${researches.length === 1 ? '' : 's'}`;
  }
  renderIcons();
}

async function loadResearches() {
  try {
    researches = await loadResearchesFromSupabase();
    renderAllResearches();
    if (researches.some((research) => ['queued', 'running'].includes(research.status))) {
      window.setTimeout(loadResearches, 2500);
    }
  } catch (error) {
    console.error('Erro ao carregar pesquisas:', error);
    renderAllResearches();
  }
}

// ============ EVENT LISTENERS ============

document.querySelector('[data-password-toggle]')?.addEventListener('click', (event) => {
  const password = document.querySelector('#password');
  if (!password) return;
  const willShow = password.type === 'password';
  password.type = willShow ? 'text' : 'password';
  event.currentTarget.setAttribute('aria-label', willShow ? 'Ocultar senha' : 'Mostrar senha');
  event.currentTarget.innerHTML = `<i data-lucide="${willShow ? 'eye-off' : 'eye'}"></i>`;
  renderIcons();
});

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const email = document.querySelector('#email').value.trim();
  const password = document.querySelector('#password').value.trim();
  
  if (!email || !password) {
    loginError.textContent = 'Informe seu e-mail e senha para continuar.';
    return;
  }
  
  // Mostrar loading
  const submitButton = loginForm.querySelector('button[type="submit"]');
  const originalText = submitButton.innerHTML;
  submitButton.innerHTML = '<i data-lucide="loader-2"></i> Entrando...';
  submitButton.disabled = true;
  renderIcons();
  
  try {
    await authenticateWithSupabase(email, password);
    loginError.textContent = '';
    await showApp();
  } catch (error) {
    loginError.textContent = error.message || 'Erro ao fazer login. Verifique suas credenciais.';
    console.error('Erro detalhado:', error);
  } finally {
    submitButton.innerHTML = originalText;
    submitButton.disabled = false;
    renderIcons();
  }
});

document.querySelector('#logout-button')?.addEventListener('click', async () => {
  try {
    await logoutFromSupabase();
    loginForm.reset();
    showLogin();
  } catch (error) {
    console.error('Erro ao fazer logout:', error);
  }
});

document.querySelector('#search-form')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const data = new FormData(form);
  const fullName = String(data.get('full-name') || '').trim();
  
  if (!fullName) {
    document.querySelector('#search-feedback').innerHTML = '<i data-lucide="circle-alert"></i><p>Inclua o nome completo.</p><span>Ele sera usado para montar a pesquisa no Google.</span>';
    renderIcons();
    return;
  }
  
  try {
    const newResearch = await createResearchInSupabase({
      source: data.get('source'),
      fullName,
      documentId: data.get('document'),
      state: data.get('state'),
      keyword: data.get('keyword')
    });
    
    form.reset();
    researches = [newResearch, ...researches];
    renderAllResearches();
    window.setTimeout(loadResearches, 1000);
  } catch (error) {
    document.querySelector('#search-feedback').innerHTML = `<i data-lucide="circle-alert"></i><p>${escapeHtml(error.message)}</p><span>Erro ao criar pesquisa. Tente novamente.</span>`;
    renderIcons();
  }
});

document.querySelector('.workspace-content')?.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-save-id]');
  if (!button) return;
  
  try {
    const newSavedState = button.dataset.saved !== 'true';
    await toggleSaveResearchInSupabase(button.dataset.saveId, newSavedState);
    
    researches = researches.map((research) => 
      research.id === parseInt(button.dataset.saveId) 
        ? { ...research, isSaved: newSavedState } 
        : research
    );
    renderAllResearches();
  } catch (error) {
    console.error('Erro ao salvar pesquisa:', error);
  }
});

document.querySelector('#profile-form')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const feedback = document.querySelector('#profile-feedback');
  const data = new FormData(event.currentTarget);
  
  try {
    const profileData = Object.fromEntries(data);
    const updatedProfile = await updateProfileInSupabase(profileData);
    renderProfile(updatedProfile);
    
    feedback.className = 'form-success';
    feedback.textContent = 'Dados atualizados.';
  } catch (error) {
    feedback.className = 'form-error';
    feedback.textContent = error.message || 'Erro ao atualizar perfil.';
  }
});

document.querySelectorAll('[data-view-link]').forEach((link) => {
  link.addEventListener('click', () => setView(link.dataset.viewLink));
});

window.addEventListener('hashchange', () => setView(getActiveView()));

// ============ INICIALIZAÇÃO ============
(async () => {
  console.log('🚀 Inicializando aplicação...');
  
  if (!supabase) {
    console.error('❌ Supabase não está disponível');
    loginError.textContent = 'Erro de configuração. Recarregue a página.';
    return;
  }
  
  try {
    const session = await getSupabaseSession();
    console.log('Sessão atual:', session ? 'Ativa' : 'Inativa');
    
    if (session) {
      await showApp();
    } else {
      showLogin();
    }
  } catch (error) {
    console.error('Erro na inicialização:', error);
    showLogin();
  }
})();