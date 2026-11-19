'use client';
import { useState } from 'react';

// Controlled, so a refused submit keeps what the admin typed: React resets uncontrolled fields after a form action
// runs, which put the example back over their edits (UX review must-fix 1, PRD DX-05).
export function KeptInput({ name, defaultValue = '', ...rest }: { name: string; defaultValue?: string } & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'name' | 'defaultValue' | 'value' | 'onChange'>) {
  const [v, setV] = useState(defaultValue);
  return <input {...rest} name={name} value={v} onChange={(e) => setV(e.currentTarget.value)} />;
}

export function KeptTextarea({ name, defaultValue = '', ...rest }: { name: string; defaultValue?: string } & Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, 'name' | 'defaultValue' | 'value' | 'onChange'>) {
  const [v, setV] = useState(defaultValue);
  return <textarea {...rest} name={name} value={v} onChange={(e) => setV(e.currentTarget.value)} />;
}
