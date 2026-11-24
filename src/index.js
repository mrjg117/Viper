import {
  createSession, validSession, sessionCookie, readCookie,
  saveTarget, loadTarget, issueTicket, redeemTicket,
} from './auth.js';
import { resolveShare } from './baidu.js';

const LOGIN_HTML = `<!doctype html><meta charset="utf-8"><title>Viper</title>
<form method="post" action="/login"><input name="password" type="password" placeholder="password"><button>login</button></form>`;

const GEN_HTML = `<!doctype html><meta charset="utf-8"><title>Viper</title>
<form method="post" action="/api/link">
<input name="share" placeholder="share url or surl" required>
<input name="pwd" placeholder="提取码（可空）">
<button>get link</button></form>
<p id="out"></p><script>
document.querySelector('form').onsubmit=async e=>{e.preventDefault();
const b=new FormData(e.target);const r=await fetch('/api/link',{method:'POST',body:b});
document.getElementById('out').textContent=await r.text();};
</script>`;

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const kv = env.VIPER_KV;
    const path = url.pathname;
    const redirectUri = `${url.origin}/auth/callback`;

    if (path === '/login' && request.method === 'GET') {
      return new Response(LOGIN_HTML, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    }

    if (path === '/login' && request.method === 'POST') {
      const form = await request.formData();
      const sid = await createSession(kv, String(form.get('password') || ''), env.ADMIN_PASSWORD);
      if (!sid) return json({ error: 'bad password' }, 401);
      return new Response('ok', { headers: { 'set-cookie': sessionCookie(sid), 'location': '/gen' }, status: 302 });
    }

    if (path === '/gen' && request.method === 'GET') {
      const sid = readCookie(request.headers.get('cookie'));
      if (!(await validSession(kv, sid))) return new Response('unauthorized', { status: 401 });
      return new Response(GEN_HTML, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    }

    if (path === '/api/link' && request.method === 'POST') {
      const sid = readCookie(request.headers.get('cookie'));
      if (!(await validSession(kv, sid))) return json({ error: 'unauthorized' }, 401);

      const form = await request.formData();
      const share = String(form.get('share') || '').trim();
      const pwd = String(form.get('pwd') || '').trim();
      if (!share) return json({ error: 'missing share' }, 400);

      let target;
      try {
        target = await resolveShare({ share, pwd, env });
      } catch (e) {
        return json({ error: String(e && e.message || e) }, 502);
      }
      if (!target || !target.dlink) return json({ error: 'no dlink' }, 404);

      const tid = crypto.randomUUID();
      await saveTarget(kv, tid, target, 1800);
      const ticket = await issueTicket(env.SIGN_SECRET, tid, 900);
      const link = `${url.origin}/p?t=${encodeURIComponent(ticket)}`;
      return json({ link, ticket, ua: target.ua || 'pan.baidu.com', expires_in: 900 });
    }

    if (path === '/p') {
      const tid = await redeemTicket(env.SIGN_SECRET, kv, url.searchParams.get('t'));
      if (!tid) return new Response('invalid or used ticket', { status: 403 });
      const target = await loadTarget(kv, tid);
      if (!target || !target.dlink) return new Response('target expired', { status: 410 });
      return new Response(null, {
        status: 302,
        headers: { location: target.dlink, 'cache-control': 'no-store' },
      });
    }

    if (path === '/auth/start') {
      const state = crypto.randomUUID();
      await kv.put(`oauth:${state}`, '1', { expirationTtl: 600 });
      const authUrl = new URL('https://openapi.baidu.com/oauth/2.0/authorize');
      authUrl.searchParams.set('response_type', 'code');
      authUrl.searchParams.set('client_id', env.BAIDU_CLIENT_ID);
      authUrl.searchParams.set('redirect_uri', redirectUri);
      authUrl.searchParams.set('scope', 'basic,netdisk');
      authUrl.searchParams.set('qrcode', '1');
      authUrl.searchParams.set('state', state);
      return new Response(null, { status: 302, headers: { location: authUrl.toString() } });
    }

    if (path === '/auth/callback') {
      const state = url.searchParams.get('state');
      if (!state || !(await kv.get(`oauth:${state}`))) return new Response('bad state', { status: 400 });
      const code = url.searchParams.get('code');
      if (!code) return new Response('no code', { status: 400 });
      const tokenUrl = new URL('https://openapi.baidu.com/oauth/2.0/token');
      tokenUrl.searchParams.set('grant_type', 'authorization_code');
      tokenUrl.searchParams.set('code', code);
      tokenUrl.searchParams.set('client_id', env.BAIDU_CLIENT_ID);
      tokenUrl.searchParams.set('client_secret', env.BAIDU_CLIENT_SECRET);
      tokenUrl.searchParams.set('redirect_uri', redirectUri);
      const r = await fetch(tokenUrl.toString());
      const data = await r.json();
      if (!data.refresh_token) return json(data, 400);
      await kv.put('baidu:tokens', JSON.stringify({
        refresh_token: data.refresh_token,
        access_token: data.access_token,
        expires_at: Math.floor(Date.now() / 1000) + Number(data.expires_in || 2592000),
      }));
      return new Response('authorized');
    }

    if (path === '/health') return json({ ok: true });
    return new Response('not found', { status: 404 });
  },

  async scheduled(_event, env) {
    const kv = env.VIPER_KV;
    const raw = await kv.get('baidu:tokens');
    if (!raw) return;
    const t = JSON.parse(raw);
    if (t.expires_at - 3600 > Math.floor(Date.now() / 1000)) return;
    const u = new URL('https://openapi.baidu.com/oauth/2.0/token');
    u.searchParams.set('grant_type', 'refresh_token');
    u.searchParams.set('refresh_token', t.refresh_token);
    u.searchParams.set('client_id', env.BAIDU_CLIENT_ID);
    u.searchParams.set('client_secret', env.BAIDU_CLIENT_SECRET);
    const r = await fetch(u.toString());
    const d = await r.json();
    if (!d.refresh_token) return;
    await kv.put('baidu:tokens', JSON.stringify({
      refresh_token: d.refresh_token,
      access_token: d.access_token,
      expires_at: Math.floor(Date.now() / 1000) + Number(d.expires_in || 2592000),
    }));
  },
};
