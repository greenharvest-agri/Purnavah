import { config, pageUrl } from './app-config.js';

const SESSION_KEY = `purnavah.admin.session:${config.environment}:${config.supabase.url}`;
let sidebar;

function notifyStorageError(error) {
  console.error('Admin session storage failed', error);
  window.toast?.('Browser session storage is unavailable. You may need to sign in again on other pages.', true);
}

function updateSidebar(admin) {
  if (!sidebar) return;
  sidebar.hidden = !admin;
  sidebar.parentElement.classList.toggle('has-admin-session', !!admin);
  sidebar.querySelector('[data-super-admin]').hidden = admin?.role !== 'Super Admin';
  sidebar.querySelector('.admin-signout').hidden = !admin;
  sidebar.querySelector('.admin-session-name').textContent = admin
    ? `${admin.name} - ${admin.role}` : 'Sign in to your workspace';
}

export function rememberAdmin(password, admin) {
  if (!admin) return;
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify({ password, admin }));
  } catch (error) {
    notifyStorageError(error);
  }
  updateSidebar(admin);
  document.getElementById('setupBar').hidden = true;
}

export function showAdminLogin() {
  document.getElementById('setupBar').hidden = false;
  if (sidebar) {
    sidebar.querySelector('[data-super-admin]').hidden = true;
    sidebar.querySelector('.admin-session-name').textContent = 'Reconnect to your workspace';
  }
}

export async function initAdminPage(connect) {
  const app = document.querySelector('.app');
  const layout = document.createElement('div');
  layout.className = 'admin-layout';
  const main = document.createElement('main');
  main.className = 'admin-main';
  main.id = 'adminMain';
  const skip = document.createElement('a');
  skip.className = 'admin-skip-link';
  skip.href = '#adminMain';
  skip.textContent = 'Skip to content';
  document.body.prepend(skip);

  sidebar = document.createElement('aside');
  sidebar.className = 'admin-sidebar';
  sidebar.hidden = true;
  sidebar.innerHTML = `
    <div class="admin-sidebar-heading">
      <span class="admin-sidebar-title">Workspace</span>
      <button class="admin-menu-toggle" type="button" aria-expanded="false" aria-controls="adminNavigation">Menu</button>
    </div>
    <nav id="adminNavigation" class="admin-navigation" aria-label="Admin navigation"></nav>
    <div class="admin-sidebar-footer">
      <p class="admin-session-name">Sign in to your workspace</p>
      <button class="admin-signout" type="button" hidden>Sign out</button>
    </div>`;
  const params = new URLSearchParams(location.search);
  const pages = [
    ['admin.html', 'Orders'], ['products.html', 'Products'],
    ['invoices.html', 'Invoices'], ['finance.html', 'Finance'],
    ['dashboard.html', 'Dashboard'], ['orderAssignment.html', 'Super Admin']
  ];
  const currentPage = location.pathname.split('/').pop();
  const nav = sidebar.querySelector('nav');
  for (const [file, label] of pages) {
    const link = document.createElement('a');
    link.className = 'admin-nav-link';
    link.href = pageUrl(file);
    link.target = '_self';
    link.textContent = label;
    if (file === currentPage) link.setAttribute('aria-current', 'page');
    if (file === 'orderAssignment.html') {
      link.dataset.superAdmin = '';
      link.hidden = true;
    }
    nav.append(link);
  }
  app.before(layout);
  layout.append(sidebar, main);
  main.append(app);
  const toggle = sidebar.querySelector('.admin-menu-toggle');
  toggle.addEventListener('click', () => {
    const open = toggle.getAttribute('aria-expanded') !== 'true';
    toggle.setAttribute('aria-expanded', String(open));
    sidebar.classList.toggle('is-open', open);
  });
  sidebar.querySelector('.admin-signout').addEventListener('click', () => {
    // Clear only after navigation succeeds, so an unsaved-edit guard can cancel it.
    const url = new URL(location.href);
    url.searchParams.delete('key');
    url.searchParams.set('logout', '1');
    location.assign(url.href);
  });

  const input = document.getElementById('adminKey');
  input.autocomplete = 'current-password';
  if (!input.hasAttribute('onkeydown')) {
    input.addEventListener('keydown', event => {
      if (event.key === 'Enter') {
        event.preventDefault();
        document.getElementById('connectBtn').click();
      }
    });
  }
  let session = null;
  try {
    if (params.has('logout')) {
      sessionStorage.removeItem(SESSION_KEY);
    } else {
      const saved = sessionStorage.getItem(SESSION_KEY);
      if (saved) {
        session = JSON.parse(saved);
        if (typeof session.password !== 'string' || !session.password || !session.admin?.adminId) {
          sessionStorage.removeItem(SESSION_KEY);
          session = null;
        }
      }
    }
  } catch (error) {
    notifyStorageError(error);
  }
  const incomingKey = params.get('key');
  if (params.has('key') || params.has('logout')) {
    params.delete('key');
    params.delete('logout');
    const query = params.toString();
    history.replaceState(null, '', location.pathname + (query ? '?' + query : '') + location.hash);
  }
  input.value = incomingKey || session?.password || '';
  if (input.value) await connect();
}
