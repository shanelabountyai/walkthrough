import Link from 'next/link';

/** The refusal a technician sees on a template page (managers only, D-16), in plain words. */
export function ManagersOnly({ slug }: { slug: string }) {
  return (
    <main className="wt-page">
      <div className="wt-narrow-col" style={{ maxWidth: 640 }}>
        <h1 className="wt-h1">Templates are for managers</h1>
        <section className="wt-card wt-card-pad" aria-label="Why">
          <p className="wt-note-14">Only owners and admins build and publish checklist templates. Your inspections show the version they were created on.</p>
          <Link className="wt-btn wt-btn-2 wt-self-start" href={`/o/${slug}/inspections`}>
            Back to my inspections
          </Link>
        </section>
      </div>
    </main>
  );
}
