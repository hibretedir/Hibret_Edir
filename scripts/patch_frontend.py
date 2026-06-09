#!/usr/bin/env python3
"""Patch public HTML files: shared CSS, logo.png, cleaner mobile UI."""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PUBLIC = ROOT / "public"
LOGO = "/logo.png"

HEAD_LINKS = """<link rel="stylesheet" href="/css/hibret.css">
<link rel="stylesheet" href="/css/compat.css">"""

HEAD_LINKS_PUBLIC = HEAD_LINKS + """
<link rel="stylesheet" href="/css/public-pages.css">"""

BASE64_IMG = re.compile(
    r'src="data:image/[^"]+"',
    re.DOTALL,
)


def strip_style_block(html: str, links: str = HEAD_LINKS) -> str:
    return re.sub(r"<style>.*?</style>\s*", links + "\n", html, count=1, flags=re.DOTALL)


def replace_logos(html: str) -> str:
    return BASE64_IMG.sub(f'src="{LOGO}"', html)


def patch_portal(html: str) -> str:
    html = strip_style_block(html)
    html = replace_logos(html)
    # Cleaner bottom nav (no emoji)
    html = html.replace('<div class="bnav-ic">🏠</div>', '<div class="bnav-ic">H</div>')
    html = html.replace('<div class="bnav-ic">📋</div>', '<div class="bnav-ic">$</div>')
    html = html.replace('<div class="bnav-ic">📤</div>', '<div class="bnav-ic">↑</div>')
    html = html.replace('<div class="bnav-ic">👤</div>', '<div class="bnav-ic">Me</div>')
    html = html.replace('🔔', '•')
    html = html.replace('<div class="phone-prefix">🇺🇸 +1</div>', '<div class="phone-prefix">+1</div>')
    # Quick actions — letter icons instead of emoji
    replacements = [
        ('<div class="qa-icon">📤</div>', '<div class="qa-icon">↑</div>'),
        ('<div class="qa-icon">👤</div>', '<div class="qa-icon">Me</div>'),
        ('<div class="qa-icon">📋</div>', '<div class="qa-icon">$</div>'),
        ('<div class="qa-icon">📞</div>', '<div class="qa-icon">☎</div>'),
        ('<div class="method-opt-icon">💚</div>', '<div class="method-opt-icon">Z</div>'),
        ('<div class="method-opt-icon">🏦</div>', '<div class="method-opt-icon">B</div>'),
        ('<div class="drop-icon">📷</div>', '<div class="drop-icon">+</div>'),
    ]
    for old, new in replacements:
        html = html.replace(old, new)
    return html


def patch_admin(html: str) -> str:
    html = strip_style_block(html)
    html = html.replace("Member Portal", "Admin Dashboard", 1)
    html = html.replace(
        '<div class="logo-sq">HE</div>',
        f'<img src="{LOGO}" alt="Hibret Edir" width="36" height="36" style="border-radius:50%;border:2px solid var(--gold)">',
    )
    # Mobile bottom nav before closing .app
    mobile_nav = """
<nav class="admin-mobile-nav" id="adminMobileNav">
  <button type="button" class="active" data-view="members" onclick="switchView('members')">Members</button>
  <button type="button" data-view="invoices" onclick="switchView('invoices')">Invoices</button>
  <button type="button" data-view="overview" onclick="switchView('overview')">Overview</button>
</nav>
"""
    html = html.replace("</div><!-- .app -->", mobile_nav + "\n</div><!-- .app -->")
    # Sync mobile nav active state in switchView
    if "adminMobileNav" not in html.split("<script>")[1][:500]:
        html = html.replace(
            "document.querySelectorAll('.nav-item').forEach",
            "document.querySelectorAll('#adminMobileNav button').forEach(b=>{b.classList.toggle('active',b.dataset.view===view);});\n  document.querySelectorAll('.nav-item').forEach",
        )
    return html


def patch_public(html: str) -> str:
    html = strip_style_block(html, HEAD_LINKS_PUBLIC)
    html = replace_logos(html)
    # Clean mobile menu — remove emoji icons
    html = re.sub(r'<span class="mi">[^<]+</span>', '', html)
    html = re.sub(r'<span class="ma">›</span>', '<span style="margin-left:auto;color:var(--text-muted)">›</span>', html)
    html = html.replace('🔐 Member Login / አባል መግቢያ', 'Member Login / አባል መግቢያ')
    html = html.replace('portal/index.html', '/portal/')
    html = html.replace('🇺🇸 English', 'English')
    html = html.replace('🇪🇹 ', '')
    # Mobile section grid — letter icons instead of emoji
    sg_map = [
        ('<span class="sg-icon">📢</span>', '<span class="sg-icon">A</span>'),
        ('<span class="sg-icon">🤝</span>', '<span class="sg-icon">i</span>'),
        ('<span class="sg-icon">📋</span>', '<span class="sg-icon">?</span>'),
        ('<span class="sg-icon">💳</span>', '<span class="sg-icon">$</span>'),
        ('<span class="sg-icon">📜</span>', '<span class="sg-icon">§</span>'),
        ('<span class="sg-icon">📞</span>', '<span class="sg-icon">☎</span>'),
    ]
    for old, new in sg_map:
        html = html.replace(old, new)
    # Add apply card if missing from grid
    if "goSection('apply')" not in html.split("sectionGrid")[1].split("ANNOUNCEMENT")[0]:
        html = html.replace(
            "<button class=\"sg-card\" onclick=\"goSection('contact')\">",
            "<button class=\"sg-card\" onclick=\"goSection('apply')\"><span class=\"sg-icon\">+</span><span>Join</span></button>\n    <button class=\"sg-card\" onclick=\"goSection('contact')\">",
        )
    return html


def main():
    files = {
        PUBLIC / "portal" / "index.html": patch_portal,
        PUBLIC / "admin" / "index.html": patch_admin,
        PUBLIC / "index.html": patch_public,
    }
    for path, fn in files.items():
        text = path.read_text(encoding="utf-8")
        new_text = fn(text)
        path.write_text(new_text, encoding="utf-8")
        old_kb = len(text) // 1024
        new_kb = len(new_text) // 1024
        print(f"Patched {path.name}: {old_kb}KB -> {new_kb}KB")


if __name__ == "__main__":
    main()
