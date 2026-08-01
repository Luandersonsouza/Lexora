// Configuração do Supabase
const SUPABASE_URL = 'https://SEU_PROJETO.supabase.co';
const SUPABASE_ANON_KEY = 'sua-chave-anon-aqui';

// Inicializar Supabase
const supabase = (() => {
  const { createClient } = window.supabase || {};
  if (!createClient) {
    console.error('Supabase não carregado. Adicione o script no HTML.');
    return null;
  }
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
})();

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
  const { data: { session } } = await supabase.auth.getSession();
  return session;
}

async function authenticateWithSupabase(email, password) {
  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password
  });
  
  if (error) throw error;
  return data;
}

async function registerWithSupabase(email, password) {
  const { data, error } = await supabase.auth.signUp({
    email,
    password
  });
  
  if (error) throw error;
  return data;
}

async function logoutFromSupabase() {
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
}

async function loadProfileFromSupabase() {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  
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
    const newProfile = {
      user_id: user.id,
      name: user.email.split('@')[0], // Nome temporário
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
    
    return createdProfile;
  }
  
  return profile;
}

async function updateProfileInSupabase(profileData) {
  const { data: { user } } = await supabase.auth.getUser();
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
  const { data: { user } } = await supabase.auth.getUser();
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
  const { data: { user } } = await supabase.auth.getUser();
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

// ============ FUNÇÕES DE UI ATUALIZADAS ============

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
  loginView.hidden = true;
  appView.hidden = false;
  setView(getActiveView());
  renderIcons();
  await loadProfile();
  await loadResearches();
}

function showLogin() {
  appView.hidden = true;
  loginView.hidden = false;
  renderIcons();
}

function renderProfile(profile) {
  if (!profile) return;
  currentProfile = profile;
  document.querySelectorAll('[data-profile-name]').forEach((node) => { node.textContent = profile.name; });
  document.querySelectorAll('[data-profile-role]').forEach((node) => { node.textContent = profile.role; });
  document.querySelector('#profile-name').value = profile.name;
  document.querySelector('#profile-email').value = profile.email;
  document.querySelector('#profile-role').value = profile.role;
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
  element.innerHTML = items.length ? items.map(researchRow).join('') : `<div class="list-empty"><i data-lucide="inbox"></i><p>${emptyMessage}</p></div>`;
}

function renderAllResearches() {
  renderSearchFeedback();
  renderResearchList(document.querySelector('#history-list'), researches, 'Nenhuma pesquisa registrada ainda.');
  renderResearchList(document.querySelector('#saved-list'), researches.filter((research) => research.isSaved), 'Nenhuma pesquisa salva ainda.');
  document.querySelector('#history-count').textContent = `${researches.length} pesquisa${researches.length === 1 ? '' : 's'}`;
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

// ============ EVENT LISTENERS ATUALIZADOS ============

document.querySelector('[data-password-toggle]').addEventListener('click', (event) => {
  const password = document.querySelector('#password');
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
  
  try {
    await authenticateWithSupabase(email, password);
    loginError.textContent = '';
    await showApp();
  } catch (error) {
    loginError.textContent = error.message || 'Erro ao fazer login. Verifique suas credenciais.';
  }
});

document.querySelector('#logout-button').addEventListener('click', async () => {
  try {
    await logoutFromSupabase();
    loginForm.reset();
    showLogin();
  } catch (error) {
    console.error('Erro ao fazer logout:', error);
  }
});

document.querySelector('#search-form').addEventListener('submit', async (event) => {
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

document.querySelector('.workspace-content').addEventListener('click', async (event) => {
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

document.querySelector('#profile-form').addEventListener('submit', async (event) => {
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

document.querySelectorAll('[data-view-link]').forEach((link) => link.addEventListener('click', () => setView(link.dataset.viewLink)));
window.addEventListener('hashchange', () => setView(getActiveView()));

// Inicialização
(async () => {
  const session = await getSupabaseSession();
  if (session) {
    await showApp();
  } else {
    showLogin();
  }
})();