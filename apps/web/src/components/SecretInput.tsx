import { useState, type ComponentProps } from 'react';
import { SECRET_MASK } from '@relay/shared';
import { Input } from '@/components/ui/input';

/**
 * Masked secret field. When a secret is already stored the value is `SECRET_MASK`, which the server
 * treats as "unchanged"; typing replaces it. The real secret is never sent to the browser.
 */
export function SecretInput({
  value,
  onChange,
  ...props
}: { value: string; onChange: (v: string) => void } & Omit<
  ComponentProps<typeof Input>,
  'value' | 'onChange' | 'type'
>) {
  const [touched, setTouched] = useState(false);
  return (
    <Input
      {...props}
      type="password"
      autoComplete="off"
      spellCheck={false}
      value={value}
      onFocus={(e) => {
        // Typing over the mask must replace it, never append to it.
        if (!touched && value === SECRET_MASK) e.currentTarget.select();
      }}
      onChange={(e) => {
        setTouched(true);
        onChange(e.target.value);
      }}
    />
  );
}
