import { useTranslation } from 'react-i18next';
import { playSound } from '@/lib/sound/engine';
import { LANGS } from '@/i18n';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import {
  useUiStore,
  type AsciiMode,
  type AsciiTone,
  type CoreMode,
  type CoreFpsCap,
  type CoreScope,
  type HomeMode,
  type Lang,
  type Theme,
} from '@/store/ui';
import { SectionCard } from './SectionCard';

/** Browser-local UI preferences (Zustand, persisted in localStorage). */
export function AppearanceCard() {
  const s = useUiStore();
  const { t } = useTranslation();
  return (
    <SectionCard
      id="appearance"
      title="Appearance & 3D core"
      description={t('settings.descriptions.appearance')}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-1.5">
          {/* Both words, so the picker is findable whichever language is on screen. */}
          <Label htmlFor="ap-lang">
            {t('settings.appearance.language')}
            {s.lang === 'en' ? ' · Bahasa' : ' · Language'}
          </Label>
          <Select id="ap-lang" value={s.lang} onChange={(e) => s.setLang(e.target.value as Lang)}>
            {LANGS.map((l) => (
              <option key={l.id} value={l.id}>
                {l.label}
              </option>
            ))}
          </Select>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="ap-home">{t('settings.appearance.landing')}</Label>
          <Select
            id="ap-home"
            value={s.homeMode}
            onChange={(e) => s.setHomeMode(e.target.value as HomeMode)}
          >
            <option value="scene">{t('settings.appearance.landingScene')}</option>
            <option value="classic">{t('settings.appearance.landingClassic')}</option>
          </Select>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="ap-view">{t('settings.appearance.coreView')}</Label>
          <Select
            id="ap-view"
            value={s.mode3d}
            onChange={(e) => s.setMode3d(e.target.value as CoreMode)}
          >
            <option value="S">{t('settings.appearance.coreS')}</option>
            <option value="A">{t('settings.appearance.coreA')}</option>
            <option value="B">{t('settings.appearance.coreB')}</option>
          </Select>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="ap-theme">{t('settings.appearance.theme')}</Label>
          <Select
            id="ap-theme"
            value={s.theme}
            onChange={(e) => s.setTheme(e.target.value as Theme)}
          >
            <option value="system">{t('settings.appearance.themeSystem')}</option>
            <option value="light">{t('settings.appearance.themeLight')}</option>
            <option value="dark">{t('settings.appearance.themeDark')}</option>
          </Select>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="ap-scope">{t('settings.appearance.scope')}</Label>
          <Select
            id="ap-scope"
            value={s.scope}
            onChange={(e) => s.setScope(e.target.value as CoreScope)}
          >
            <option value="cycle">{t('settings.appearance.scopeCycle')}</option>
            <option value="all">{t('settings.appearance.scopeAll')}</option>
          </Select>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="ap-ascii">{t('settings.appearance.ascii')}</Label>
          <Select
            id="ap-ascii"
            value={s.ascii === 'full' ? 'full' : 'off'}
            onChange={(e) => s.setAscii(e.target.value as AsciiMode)}
          >
            {/* The text ring is retired (Paper & Ink): a stored "text" reads as off. */}
            <option value="off">{t('settings.appearance.asciiOff')}</option>
            <option value="full">{t('settings.appearance.asciiFull')}</option>
          </Select>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="ap-tone">{t('settings.appearance.asciiTone')}</Label>
          <Select
            id="ap-tone"
            value={s.asciiTone}
            disabled={s.ascii !== 'full'}
            onChange={(e) => s.setAsciiTone(e.target.value as AsciiTone)}
          >
            <option value="color">{t('settings.appearance.toneColor')}</option>
            <option value="dull">{t('settings.appearance.toneDull')}</option>
          </Select>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="ap-fps">{t('settings.appearance.fps')}</Label>
          <Select
            id="ap-fps"
            value={s.fpsCap}
            onChange={(e) => s.setFpsCap(Number(e.target.value) as CoreFpsCap)}
          >
            <option value={0}>{t('settings.appearance.fpsNone')}</option>
            <option value={60}>{t('settings.appearance.fps60')}</option>
            <option value={30}>{t('settings.appearance.fps30')}</option>
          </Select>
        </div>
        <div className="flex items-center justify-between gap-3 sm:col-span-2">
          <div className="grid gap-0.5">
            <Label htmlFor="ap-sound">{t('settings.appearance.sound')}</Label>
            <p className="text-xs text-muted-foreground">{t('settings.appearance.soundHint')}</p>
          </div>
          <Switch
            id="ap-sound"
            checked={s.soundOn}
            onCheckedChange={(on) => {
              s.setSoundOn(on);
              // Turning it on answers with the sound itself, so it is clear what was enabled.
              if (on) playSound('tick');
            }}
          />
        </div>
        <div className="flex items-center justify-between gap-3 sm:col-span-2">
          <div className="grid gap-0.5">
            <Label htmlFor="ap-haptics">{t('settings.appearance.haptics')}</Label>
            <p className="text-xs text-muted-foreground">{t('settings.appearance.hapticsHint')}</p>
          </div>
          <Switch id="ap-haptics" checked={s.hapticsOn} onCheckedChange={s.setHapticsOn} />
        </div>
      </div>
    </SectionCard>
  );
}
