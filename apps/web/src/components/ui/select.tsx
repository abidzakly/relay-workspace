import {
  Children,
  isValidElement,
  type ChangeEvent,
  type ComponentProps,
  type ReactElement,
  type ReactNode,
} from 'react';
import { Dropdown, type DropdownOption } from '@/components/Dropdown';
import { cn } from '@/lib/utils';

type OptionProps = { value?: string | number; disabled?: boolean; children?: ReactNode };

/** Plain text of an option's children (an option only ever holds text). */
function textOf(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children);
  return '';
}

/** The `<option>`s under a select, through fragments, arrays and `<optgroup>`s. */
function optionsOf(children: ReactNode): DropdownOption<string>[] {
  const out: DropdownOption<string>[] = [];
  Children.forEach(children, (child) => {
    if (!isValidElement(child)) return;
    const el = child as ReactElement<OptionProps>;
    if (el.type === 'option') {
      const label = textOf(el.props.children);
      out.push({
        value: String(el.props.value ?? label),
        label,
        ...(el.props.disabled ? { disabled: true } : {}),
      });
    } else {
      out.push(...optionsOf(el.props.children));
    }
  });
  return out;
}

/**
 * The app's select (Paper & Ink): the same API as a native `<select>` — `value`, `onChange(e)` with
 * `e.target.value`, `<option>` children, `id` for a `<Label htmlFor>`, `aria-label`, `disabled` — drawn as the themed
 * `Dropdown`. Every existing `<Select>` gets the new look without changing its call site.
 *
 * Sizing follows the old classes: `h-8` (or `text-xs`) is the small trigger, `w-auto` sizes it to its text, anything
 * else sits on the wrapper (`w-44`, `max-w-48`, grid spans).
 */
export function Select({
  className,
  children,
  value,
  defaultValue,
  onChange,
  id,
  name,
  disabled,
  'aria-label': ariaLabel,
  'aria-invalid': ariaInvalid,
  'aria-required': ariaRequired,
}: ComponentProps<'select'>) {
  const options = optionsOf(children);
  const current = value ?? defaultValue;
  const picked = current === undefined || current === null ? null : String(current);
  const small = /\bh-8\b|\btext-xs\b/.test(className ?? '');
  const auto = /\bw-auto\b/.test(className ?? '');
  const wrapper = (className ?? '')
    .split(/\s+/)
    .filter((c) => c && !/^(h-\d+|w-auto|text-xs)$/.test(c))
    .join(' ');

  return (
    <Dropdown
      options={options}
      value={picked}
      onChange={(v) => {
        // The shape every caller already reads: `e.target.value` (and `currentTarget`).
        const target = { value: v, name: name ?? '', id: id ?? '' };
        onChange?.({ target, currentTarget: target } as unknown as ChangeEvent<HTMLSelectElement>);
      }}
      {...(ariaLabel ? { label: ariaLabel } : {})}
      {...(id ? { id } : {})}
      {...(name ? { name } : {})}
      {...(disabled ? { disabled: true } : {})}
      ariaInvalid={ariaInvalid === true || ariaInvalid === 'true'}
      ariaRequired={ariaRequired === true || ariaRequired === 'true'}
      width={auto ? 'auto' : 'full'}
      size={small ? 'sm' : 'md'}
      className={cn(!auto && 'w-full', wrapper)}
    />
  );
}
