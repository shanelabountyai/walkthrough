// public: the root shell; renders no data
import './ui/walkthrough.css';

export const metadata = { title: { default: 'Walkthrough', template: '%s · Walkthrough' } };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
