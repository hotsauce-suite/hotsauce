#!/usr/bin/env python3
# One-off (0.15): renames the old "Hearth" spelling in code to "Hotsauce", leaving the saved names
# older files, links and apps depend on (PROTECT). Safe to run again: a branch started before the
# rename can merge main and run `python3 scripts/rename-hearth.py` to fix its own new code.
import re, subprocess, sys, os
os.chdir(subprocess.check_output(['git','rev-parse','--show-toplevel']).decode().strip())
files = subprocess.check_output(['git','ls-files']).decode().split('\n')
SKIP_PREFIX = ('docs/learnings/','docs/plans/','docs/PLAN-','docs/AUDIT','site/public/help/agents.html')
SKIP = {'pnpm-lock.yaml','README.md'}  # README hand-edited
EXT = ('.ts','.tsx','.js','.mjs','.cjs','.json','.jsonc','.css','.html','.swift','.sh','.yml','.yaml','.toml','.md','.txt','Dockerfile','.svg','.plist','.entitlements')
PROTECT = [
  r'\.hearth(?![-\w])',            # data folder .hearth/
  r'hearth:',                       # link scheme, storage keys, SW message
  r'hearth-dictate', r'hearth://',
  r"'hearth'", r'"hearth"',
  r'Hearth-Via', r'Hearth-Label', r'Hearth-Conflict-Path',
  r'hearth(?:Mac|Location|Notifications|MeetingAudio|DictateConnect|Download|SignIn|Ticket|Booking)\b',
  r'hearth-mac-audio', r'hearth-page', r'hearth-extension',
  r'hearth\.[a-z]', r'hearthSelfTest', r'x-hearth-dev-user', r'hearth-assets',
  r'HEARTH_COMMITTER_\w+', r'HEARTH_URL', r'HEARTH_DICTATE_\w+',
  r'hearth-meetings-chrome\.zip', r'Hearth\.\$ext', r'HearthDictate\.\$ext',
  r'"HearthDictate\.app"', r'"Hearth\.app"', r'"HearthDictate"', r'"HearthDictateMain"',
  r'Support/HearthDictate', r'Autosave Name HearthDictate', r'Preferred Position HearthDictate', r'\(`HearthDictate`\)',
  r'hearthwork\.app', r'hearth-havenbiosec', r'haven-hearth',
  r'\|Hearth\w*', r'Hearth\w*\|', r'hearth\\\.',   # alternations and escaped dots in regexes (old names)
  r'/hearth/clips', r'Hearth(?:Dictate)?\.(?:zip|dmg|app)\b',
  r'hearth-meetings-audio', r'A Hearth Whiteboard', r'hearth-feedback-reply', r'hearth-submitter',
]
prot = re.compile('|'.join('(?:%s)'%p for p in PROTECT))
def conv(m):
    t=m.group(0)
    return {'HEARTH':'HOTSAUCE','Hearth':'Hotsauce','hearth':'hotsauce'}.get(t,t)
word = re.compile(r'HEARTH|Hearth|hearth')
changed=[]
for f in files:
    if not f or f in SKIP or f.startswith(SKIP_PREFIX) or not (f.endswith(EXT)): continue
    if f.endswith('.md') and not (f.endswith('README.md') or f in ('docs/ARCHITECTURE.md','docs/mcp.md','docs/self-host.md','CONTRIBUTING.md','CLAUDE.md','AGENTS.md','SECURITY.md') or f.startswith('apps/web/src/mocks/') or f.startswith('scripts/')): continue
    try: s=open(f).read()
    except Exception: continue
    if not word.search(s): continue
    out=[]; i=0
    for m in prot.finditer(s):
        out.append(word.sub(conv, s[i:m.start()])); out.append(m.group(0)); i=m.end()
    out.append(word.sub(conv, s[i:]))
    n=''.join(out)
    if n!=s: open(f,'w').write(n); changed.append(f)
print(f'{len(changed)} files changed'); [print('  '+c) for c in changed]
