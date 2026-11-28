import type { Messages } from '../../types';
import type { testBench as en } from '../en/testBench';

export const testBench: Messages<typeof en> = {
  mirror: {
    noAnswer:
      'Ponsel tidak menjawab tepat waktu. Buka kuncinya (atau pastikan emulator berjalan), lalu tekan Reconnect.',
  },
  title: {
    device: 'Tes di perangkat',
    web: 'Tes di browser',
  },
  panes: {
    checks: 'Pemeriksaan',
    phone: 'Ponsel',
    preview: 'Pratinjau',
    design: 'Desain',
  },
  web: {
    noWorkspace:
      'Belum ada workspace cockpit untuk repo ini, jadi dev server tidak bisa dijalankan dari sini.',
    addWorkspace: 'Tambahkan',
    wrongBranch:
      '{{ws}} sedang di <0>{{branch}}</0>, bukan branch ini. Saat dijalankan, branch ini di-checkout dulu.',
    stopFirst: 'Hentikan dev server dulu',
    checkoutTitle: 'Checkout {{branch}} di {{ws}}',
    checkoutNow: 'Checkout sekarang',
    checkoutThenRun: 'Checkout {{branch}} dulu, lalu jalankan',
    script: 'Script',
    scriptPick: 'Script…',
    noScripts: 'package.json tidak punya script untuk dijalankan.',
    run: 'Jalankan dev server',
    restart: 'Mulai ulang',
    stop: 'Hentikan',
    logs: 'Log',
    usesPm: '{{pm}} run {{script}}',
    preview: {
      label: 'Pratinjau',
      idle: 'Jalankan dev server untuk melihat aplikasinya di sini.',
      starting: 'Menyalakan dev server…',
      startingHint:
        'Dependency di-install dulu kalau belum ada atau sudah usang. Progresnya ada di log.',
      exited:
        'Dev server tidak berjalan. Jalankan lagi, atau buka log untuk melihat bagaimana ia berhenti.',
      width: 'Lebar pratinjau',
      mobile: 'Ponsel',
      tablet: 'Tablet',
      desktop: 'Desktop',
      reload: 'Muat ulang',
      open: 'Buka di browser',
      frameTitle: 'Pratinjau {{url}}',
      blocked:
        'Aplikasi menolak ditampilkan di dalam halaman lain (X-Frame-Options atau CSP frame-ancestors). Buka di browser saja.',
      remote:
        'Dev server berjalan di Mac, jadi pratinjau hanya tampil kalau Relay dibuka di browser di Mac itu. Dari sini, buka alamatnya di Mac.',
    },
  },
};
