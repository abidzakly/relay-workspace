import { playSound } from '@/lib/sound/engine';
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
  type Theme,
} from '@/store/ui';
import { SectionCard } from './SectionCard';

/** Browser-local UI preferences (Zustand, persisted in localStorage). */
export function AppearanceCard() {
  const s = useUiStore();
  return (
    <SectionCard
      id="appearance"
      title="Appearance & 3D core"
      description="Stored in this browser only."
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor="ap-home">Landing page</Label>
          <Select
            id="ap-home"
            value={s.homeMode}
            onChange={(e) => s.setHomeMode(e.target.value as HomeMode)}
          >
            <option value="scene">Living Workspace — 3D world (default)</option>
            <option value="classic">Classic — sidebar + Overview</option>
          </Select>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="ap-view">Overview core view</Label>
          <Select
            id="ap-view"
            value={s.mode3d}
            onChange={(e) => s.setMode3d(e.target.value as CoreMode)}
          >
            <option value="S">Crystal: shards gather as cards progress</option>
            <option value="A">Ring: shards on one orbit</option>
            <option value="B">Shatter: the core opened into its pieces</option>
          </Select>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="ap-theme">Theme</Label>
          <Select
            id="ap-theme"
            value={s.theme}
            onChange={(e) => s.setTheme(e.target.value as Theme)}
          >
            <option value="system">System</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </Select>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="ap-scope">Progress scope</Label>
          <Select
            id="ap-scope"
            value={s.scope}
            onChange={(e) => s.setScope(e.target.value as CoreScope)}
          >
            <option value="cycle">Current release cycle</option>
            <option value="all">All-time</option>
          </Select>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="ap-ascii">ASCII rendering</Label>
          <Select
            id="ap-ascii"
            value={s.ascii === 'full' ? 'full' : 'off'}
            onChange={(e) => s.setAscii(e.target.value as AsciiMode)}
          >
            {/* The text ring is retired (Paper & Ink): a stored "text" reads as off. */}
            <option value="off">Off</option>
            <option value="full">Full scene</option>
          </Select>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="ap-tone">ASCII tone</Label>
          <Select
            id="ap-tone"
            value={s.asciiTone}
            disabled={s.ascii !== 'full'}
            onChange={(e) => s.setAsciiTone(e.target.value as AsciiTone)}
          >
            <option value="color">Color</option>
            <option value="dull">Dull</option>
          </Select>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="ap-fps">3D frame rate cap</Label>
          <Select
            id="ap-fps"
            value={s.fpsCap}
            onChange={(e) => s.setFpsCap(Number(e.target.value) as CoreFpsCap)}
          >
            <option value={0}>No cap</option>
            <option value={60}>60 FPS</option>
            <option value={30}>30 FPS</option>
          </Select>
        </div>
        <div className="flex items-center justify-between gap-3 sm:col-span-2">
          <div className="grid gap-0.5">
            <Label htmlFor="ap-sound">Sound</Label>
            <p className="text-xs text-muted-foreground">
              Marimba and wood sounds on rewards. Off until you turn it on.
            </p>
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
            <Label htmlFor="ap-haptics">Haptics</Label>
            <p className="text-xs text-muted-foreground">
              A small vibration on rewards, on devices that support it.
            </p>
          </div>
          <Switch id="ap-haptics" checked={s.hapticsOn} onCheckedChange={s.setHapticsOn} />
        </div>
      </div>
    </SectionCard>
  );
}
