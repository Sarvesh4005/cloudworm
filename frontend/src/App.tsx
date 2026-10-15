import { Link, Route, Routes } from "react-router-dom";
import { Card } from "./components/ui";
import { ReceivePage } from "./pages/ReceivePage";
import { SendPage } from "./pages/SendPage";

function NotFound() {
  return (
    <Card className="mx-auto max-w-md text-center">
      <h1 className="text-2xl font-bold text-white">Page not found</h1>
      <p className="mt-2 text-slate-400">This page fell into a black hole.</p>
      <Link to="/" className="mt-5 inline-block text-cyan-300 underline-offset-4 hover:underline">
        Go to CloudWorm
      </Link>
    </Card>
  );
}

export default function App() {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="mx-auto flex w-full max-w-4xl items-center justify-between px-4 py-5 sm:px-6">
        <Link to="/" className="flex items-center gap-2.5 font-bold tracking-tight text-white">
          <img src="/favicon.svg" alt="" className="size-8" />
          <span className="text-lg">CloudWorm</span>
        </Link>
        <span className="hidden text-sm text-slate-400 sm:block">AES-256-GCM · end-to-end encrypted</span>
      </header>
      <main className="mx-auto w-full max-w-4xl flex-1 px-4 pb-16 sm:px-6">
        <Routes>
          <Route path="/" element={<SendPage />} />
          <Route path="/t/:transferId" element={<ReceivePage />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </main>
      <footer className="px-4 pb-8 text-center text-xs text-slate-500">
        Files are encrypted in your browser. Anyone with the full link can download until it expires.
      </footer>
    </div>
  );
}
