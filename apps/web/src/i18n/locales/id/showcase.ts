import type { Messages } from '../../types';
import type { showcase as en } from '../en/showcase';

export const showcase: Messages<typeof en> = {
  title: 'Apa yang Relay kerjakan untukmu',
  lede: 'Sekilas fitur yang sedang aktif. Buka salah satunya sekarang, atau kembali ke tur ini kapan saja.',
  slides: 'Slide tur',
  skip: 'Lewati tur',
  done: 'Selesai',
  open: 'Buka',
  openSettings: 'Atur',
  needsNotion: 'Perlu Notion',
  needsNotionHint: 'Hubungkan Notion di Settings dulu.',
  reopen: 'Lihat tur fitur',
  groups: {
    code: 'Kode & review',
    ship: 'Build & rilis',
    plan: 'Perencanaan',
  },
  groupLede: {
    code: 'Merge request dan kode di dalamnya.',
    ship: 'Dari sesi agent sampai build di perangkat uji.',
    plan: 'Kartu, sprint, dan hari kerjamu.',
  },
  final: {
    rail: 'Setup',
    title: 'Selesaikan setup',
    body: 'Beberapa fitur menunggu koneksi atau token. Checklist setup di bagian atas Settings mencantumkan apa yang belum ada dan apa yang dibukanya.',
    allSet:
      'Semua sudah diatur. Fitur bisa dinyalakan atau dimatikan di Settings > General > Features.',
    missing_one: '{{count}} hal belum diatur',
    missing_other: '{{count}} hal belum diatur',
    link: 'Buka checklist setup',
  },
  features: {
    board: 'Kartu Notion-mu per status, beserta merge request-nya.',
    mrInbox: 'Merge request di repo-mu, diurutkan menurut yang menunggumu.',
    codeReview: 'Baca diff sebuah merge request atau dua branch di repo-mu.',
    reviews:
      'Merge request di project mana pun tempat kamu reviewer atau di-mention. Perlu personal GitLab token.',
    cockpit: 'Sesi coding agent untuk kartumu, masing-masing di worktree sendiri.',
    testBench: 'Cek aplikasi yang berjalan terhadap frame Figma-nya.',
    release: 'Merge request versi, tag, dan release train.',
    builds: 'Build Flutter, upload, dan antrean build.',
    syncHealth: 'Kartu dan merge request yang tidak cocok, dengan perbaikan sekali klik.',
    kpi: 'Preset poin, effort, dan SLA untuk tim yang melacaknya.',
    sprints: 'Kapasitas sprint dan apa yang muat di dalamnya.',
    calendar: 'Meeting Google Calendar-mu, dengan peringatan mengambang saat meeting berlangsung.',
    reader: 'Dokumen Markdown dan teks untuk dibaca di kolom yang tenang, di perangkat apa pun.',
  },
};
