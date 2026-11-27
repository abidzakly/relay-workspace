import type { Messages } from '../../types';
import type { cockpit as en } from '../en/cockpit';

export const cockpit: Messages<typeof en> = {
  title: 'Cockpit',
  tabs: {
    label: 'Tampilan Cockpit',
    agent: 'Agen',
    review: 'Tinjau',
    run: 'Jalankan',
    terminal: 'Terminal',
    files: 'Berkas',
  },
  kind: {
    claude: 'Claude',
    cursor: 'Cursor',
    shell: 'Shell',
    flutter: 'Jalankan',
  },
  workspace: {
    menu: 'Workspace',
    current: 'Workspace: {{name}}',
    worktree: 'Worktree',
    waiting: '{{count}} menunggu kamu',
    removeWorktree: 'Hapus worktree {{name}}',
    stopFirst: 'Hentikan sesinya dulu',
    removeHint: 'Hapus folder worktree ini (branch dan commit-nya tetap ada)',
    removeConfirm:
      'Hapus worktree {{name}}? Foldernya dihapus, perubahan yang belum di-commit hilang. Branch dan commit-nya tetap ada.',
    removed: 'Workspace dihapus',
    add: 'Tambah workspace',
  },
  helper: {
    start: 'memulai',
    working: 'bekerja',
    'needs-you': 'butuh kamu',
    idle: 'diam',
    finished: 'selesai',
    failed: 'gagal',
  },
  load: {
    failed: 'Cockpit tidak bisa dimuat',
    noWorkspace:
      'Tambahkan workspace (folder repo di komputer ini) dulu untuk menjalankan agen, terminal, dan aplikasinya.',
  },
  dock: {
    label: 'Sesi',
    newSession: 'Sesi baru',
    startCard: 'Mulai kartu',
    needsYou: 'Butuh kamu',
    empty: 'Belum ada sesi',
  },
  sheet: {
    noSession: 'Tidak ada sesi terbuka',
    noAgent: 'Belum ada sesi agen di workspace ini.',
    noTerminal: 'Belum ada terminal.',
    startAgent: 'Mulai agen',
    openTerminal: 'Buka terminal',
  },
  phase: {
    label: 'Progres',
    plan: 'Rencana',
    approve: 'Setujui',
    work: 'Kerjakan',
    review: 'Tinjau',
  },
  turn: {
    you: 'Kamu · giliran {{n}}',
    agent: 'Agen',
    folded: 'Giliran {{n}}',
    steps_one: '{{count}} langkah',
    steps_other: '{{count}} langkah',
    show: 'Tampilkan giliran {{n}}',
    hide: 'Lipat giliran {{n}}',
    earlier_one: 'Tampilkan {{count}} giliran sebelumnya',
    earlier_other: 'Tampilkan {{count}} giliran sebelumnya',
  },
};
