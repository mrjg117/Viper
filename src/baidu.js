const UA = 'pan.baidu.com';

export async function getAccessToken(kv, env) {
  const raw = await kv.get('baidu:tokens');
  if (!raw) throw new Error('not authorized: visit /auth/start');
  const t = JSON.parse(raw);
  const now = Math.floor(Date.now() / 1000);
  if (t.expires_at - 3600 > now) return t.access_token;

  const u = new URL('https://openapi.baidu.com/oauth/2.0/token');
  u.searchParams.set('grant_type', 'refresh_token');
  u.searchParams.set('refresh_token', t.refresh_token);
  u.searchParams.set('client_id', env.BAIDU_CLIENT_ID);
  u.searchParams.set('client_secret', env.BAIDU_CLIENT_SECRET);
  const r = await fetch(u.toString());
  const d = await r.json();
  if (!d.access_token) throw new Error('refresh failed: ' + JSON.stringify(d));
  await kv.put('baidu:tokens', JSON.stringify({
    refresh_token: d.refresh_token || t.refresh_token,
    access_token: d.access_token,
    expires_at: now + Number(d.expires_in || 2592000),
  }));
  return d.access_token;
}

export function parseShare(input, pwd) {
  let s = String(input || '').trim();
  let code = pwd || '';
  const mPwd = s.match(/[?&]pwd=([^&#]+)/);
  if (mPwd && !code) code = decodeURIComponent(mPwd[1]);
  const mShort = s.match(/pan\.baidu\.com\/s\/([A-Za-z0-9_-]+)/);
  if (mShort) return { surl: mShort[1], pwd: code };
  const mBare = s.match(/^([A-Za-z0-9_-]{10,})$/);
  if (mBare) return { surl: mBare[1], pwd: code };
  throw new Error('unrecognized share link');
}

async function shareMeta(surl, pwd) {
  const url = `https://pan.baidu.com/s/${surl}${pwd ? `?pwd=${encodeURIComponent(pwd)}` : ''}`;
  const r = await fetch(url, { headers: { 'user-agent': UA } });
  const html = await r.text();
  const pick = (re) => { const m = html.match(re); return m ? m[1] : null; };
  const shareid = pick(/"shareid"\s*:\s*"?(\d+)"?/);
  const uk = pick(/"uk"\s*:\s*"?(\d+)"?/);
  const fsid = pick(/"fs_id"\s*:\s*"?(\d+)"?/);
  if (!shareid || !uk) throw new Error('cannot read share meta (link expired or pwd wrong)');
  return { shareid, uk, fsid };
}

export async function resolveShare({ share, pwd, env }) {
  const { surl, pwd: code } = parseShare(share, pwd);
  const token = await getAccessToken(env.VIPER_KV, env);
  const meta = await shareMeta(surl, code);

  const transferUrl = new URL('https://pan.baidu.com/rest/2.0/xpan/share');
  transferUrl.searchParams.set('method', 'transfer');
  transferUrl.searchParams.set('access_token', token);
  transferUrl.searchParams.set('shareid', meta.shareid);
  transferUrl.searchParams.set('from', meta.uk);
  transferUrl.searchParams.set('path', `/apps/viper/${surl}`);
  const body = new URLSearchParams();
  if (meta.fsid) body.set('fsidlist', JSON.stringify([Number(meta.fsid)]));

  const tr = await fetch(transferUrl.toString(), {
    method: 'POST', headers: { 'user-agent': UA, 'content-type': 'application/x-www-form-urlencoded' }, body: body.toString(),
  });
  const td = await tr.json();
  if (td.errno) throw new Error('transfer failed: errno=' + td.errno);

  const fsids = (td.list || []).map(x => x.fs_id || x.fsId).filter(Boolean);
  if (!fsids.length) throw new Error('transfer returned no fs_id');

  const metaUrl = new URL('https://pan.baidu.com/rest/2.0/xpan/multimedia');
  metaUrl.searchParams.set('method', 'filemetas');
  metaUrl.searchParams.set('access_token', token);
  metaUrl.searchParams.set('fsids', JSON.stringify(fsids.map(Number)));
  metaUrl.searchParams.set('dlink', '1');
  const mr = await fetch(metaUrl.toString(), { headers: { 'user-agent': UA } });
  const md = await mr.json();
  const file = (md.list || [])[0];
  if (!file || !file.dlink) throw new Error('no dlink: ' + JSON.stringify(md));

  return { dlink: file.dlink, ua: UA, filename: file.filename, size: file.size, fsids };
}
