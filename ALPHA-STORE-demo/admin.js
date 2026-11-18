const byId = id => document.getElementById(id);
const login = byId('login');
const dashboard = byId('dashboard');
const message = byId('message');
const orders = byId('orders');
const statuses = { new: 'جديد', reviewed: 'تمت المراجعة', cancelled: 'ملغى' };
let page = 0;

async function request(path, method = 'GET', value) {
  const options = { method };
  if (value !== undefined) {
    options.headers = { 'Content-Type': 'application/json' };
    options.body = JSON.stringify(value);
  }
  const response = await fetch('/api/admin/' + path, options);
  if (!response.ok) throw new Error(String(response.status));
  return response.json();
}

function showLogin(text) {
  dashboard.hidden = true;
  orders.replaceChildren();
  login.hidden = false;
  message.textContent = text;
}

function handleError(error) {
  if (error.message === '401') return showLogin('سجّل الدخول للوصول إلى الطلبات.');
  message.textContent = ({
    429: 'محاولات كثيرة. حاول مجددًا بعد 15 دقيقة.',
    503: 'لوحة الإدارة غير مفعّلة في إعدادات الخادم.',
  })[error.message] || 'تعذر الاتصال بالإدارة. حاول مجددًا.';
}

function render(order) {
  const card = document.createElement('article');
  const reference = document.createElement('bdi');
  reference.textContent = order.id;
  const summary = document.createElement('p');
  summary.textContent = order.items.map(([amount]) => amount + ' V-Bucks').join('، ') +
    ' · ' + order.total + ' ر.س تجريبي · ' + new Date(order.created).toLocaleString('ar-SA');
  const label = document.createElement('label');
  label.textContent = 'حالة الطلب ';
  const select = document.createElement('select');
  for (const [value, title] of Object.entries(statuses)) select.add(new Option(title, value));
  select.value = order.status;
  label.append(select);
  select.addEventListener('change', async () => {
    select.disabled = true;
    try {
      await request('orders/' + order.id, 'PATCH', { status: select.value });
      order.status = select.value;
      message.textContent = 'تم حفظ حالة الطلب.';
    } catch (error) {
      select.value = order.status;
      handleError(error);
    } finally {
      select.disabled = false;
    }
  });
  card.append(reference, summary, label);
  return card;
}

async function load(target = page) {
  try {
    const result = await request('orders?page=' + target);
    page = target;
    login.hidden = true;
    dashboard.hidden = false;
    message.textContent = '';
    orders.replaceChildren(...result.orders.map(render));
    if (!result.orders.length) orders.textContent = 'لا توجد طلبات تجريبية في هذه الصفحة.';
    byId('previous').disabled = page === 0;
    byId('next').disabled = !result.more;
  } catch (error) {
    handleError(error);
  }
}

login.addEventListener('submit', async event => {
  event.preventDefault();
  const button = login.querySelector('button');
  const password = byId('password');
  button.disabled = true;
  try {
    await request('login', 'POST', { password: password.value });
    await load(0);
  } catch (error) {
    if (error.message === '401') message.textContent = 'كلمة المرور غير صحيحة.';
    else handleError(error);
  } finally {
    password.value = '';
    button.disabled = false;
  }
});
byId('logout').addEventListener('click', async () => {
  try {
    await request('logout', 'POST');
    showLogin('تم تسجيل الخروج.');
  } catch (error) {
    handleError(error);
  }
});
byId('refresh').onclick = () => load();
byId('previous').onclick = () => load(page - 1);
byId('next').onclick = () => load(page + 1);
load();
