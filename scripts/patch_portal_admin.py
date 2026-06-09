from pathlib import Path
import re

root = Path('public')
portal = root / 'portal' / 'index.html'
admin = root / 'admin' / 'index.html'

portal_text = portal.read_text(encoding='utf-8')
portal_text, portal_count = re.subn(
    r'const MEMBERS = \[.*?const MY_INVOICES = \[\];',
    'const MY_INVOICES = [];',
    portal_text,
    flags=re.S,
)
print('portal block replace count:', portal_count)

portal_text = portal_text.replace(
    "function getMyInvs() {\n  if (MY_INVOICES.length) {\n    return MY_INVOICES;\n  }\n  const m = me || {};\n  const pp = (m.paypal_name || '').toLowerCase();\n  const fn = (m.first || '').toLowerCase();\n  const ln = (m.last || '').toLowerCase();\n  return INVOICES.filter(inv => {\n    const n = inv.name.toLowerCase();\n    return n === pp || (n.includes(fn) && n.includes(ln)) || n === fn + ' ' + ln;\n  });\n}\n",
    'function getMyInvs() {\n  return MY_INVOICES;\n}\n'
)

portal_text = portal_text.replace(
    "  } catch (error) {\n    console.warn('Auth phone lookup failed, falling back to local data', error);\n    const m=findMember(p);\n    if(!m){\n      err.textContent='Phone not found. Contact (424) 547-5594 for help.';\n      err.classList.add('show');\n      return;\n    }\n    me=m;\n    const stored=PINS[normPhone(p)];\n    if(!stored){\n      show('sCreate');\n      ['n0','n1','n2','n3','c0','c1','c2','c3'].forEach(id=>document.getElementById(id).value='');\n      document.getElementById('createErr').classList.remove('show');\n      setTimeout(()=>document.getElementById('n0').focus(),100);\n    } else {\n      document.getElementById('pinTitle').textContent='Hi '+m.first+'! 👋';\n      document.getElementById('pinSub').textContent='Enter your 4-digit PIN to continue';\n      show('sPin');\n      ['p0','p1','p2','p3'].forEach(id=>{const el=document.getElementById(id).value='';el.classList.remove('filled');});\n      document.getElementById('pinErr').classList.remove('show');\n      document.getElementById('pinBtn').disabled=true;\n      setTimeout(()=>document.getElementById('p0').focus(),100);\n    }\n  }\n",
    "  } catch (error) {\n    console.error('Auth phone lookup failed:', error);\n    err.textContent = 'Unable to verify phone number right now. Please try again later.';\n    err.classList.add('show');\n  }\n"
)

portal_text = re.sub(r'function findMember\([^\)]*\)\s*\{[^\}]*\}\n\n', '', portal_text)
portal_text = portal_text.replace("    PINS[normPhone(myPhone)] = np;\n", '')
portal_text = portal_text.replace(
    "function saveCP(){\n  const np=getP('np'),cp=getP('cp');\n  const err=document.getElementById('cpErr');\n  if(np!==cp||np.length<4){err.classList.add('show');return;}\n  err.classList.remove('show');\n  PINS[normPhone(myPhone)]=np;\n  closeModal('cpModal');\n  alert('PIN updated successfully!');\n}\n",
    "async function saveCP(){\n  const np=getP('np'),cp=getP('cp');\n  const err=document.getElementById('cpErr');\n  if(np!==cp||np.length<4){err.classList.add('show');return;}\n  err.classList.remove('show');\n  try {\n    await apiPost('auth/create-pin',{ phone: myPhone, pin: np });\n    closeModal('cpModal');\n    alert('PIN updated successfully!');\n  } catch (error) {\n    err.textContent = error.message || 'Unable to update PIN. Please try again.';\n    err.classList.add('show');\n    console.error('Change PIN failed:', error);\n  }\n}\n"
)
portal_text = re.sub(
    r'// DEMO BUTTON\nconst db=.*?document\.body\.appendChild\(db\);\n',
    '',
    portal_text,
    flags=re.S,
)
portal.write_text(portal_text, encoding='utf-8')
print('portal modified')

admin_text = admin.read_text(encoding='utf-8')
admin_text, admin_count = re.subn(
    r'const MEMBERS = \[.*?\];\s*const INVOICES = \[.*?\];',
    'const MEMBERS = [];
const INVOICES = [];',
    admin_text,
    flags=re.S,
)
print('admin block replace count:', admin_count)
admin.write_text(admin_text, encoding='utf-8')
print('admin modified')
