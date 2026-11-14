'use server';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { orgAction, ref } from '@/core/authz/action';
import { createInspectionRecord } from '@/lib/walkthrough/store';

// Creating an inspection writes its server-issued template pin in the same transaction (D-15). Managers only (D-16).
export const addInspection = orgAction(
  'org.update',
  z.object({ templateId: ref('checklistTemplate'), assigneeId: ref('member'), title: z.string().trim().min(1, 'Give the inspection a title.').max(200) }),
  async (ctx, i) => {
    const { id } = await createInspectionRecord(ctx, i);
    redirect(`/o/${ctx.slug}/inspections/${id}`);
  },
);
