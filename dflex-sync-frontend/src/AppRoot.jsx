import { AuthProvider, useAuth } from './auth/AuthProvider';
import LoginPage from './pages/LoginPage';
import App from './App';
import PdfLinkView from './pages/PdfLinkView';
import { isPdfLinkMode } from './utils/pdfLinkMode';

function Gate() {
  const { session, loading } = useAuth();
  const linkMode = isPdfLinkMode();
  if (linkMode) return <PdfLinkView />;

  if (loading) {
    return (
      <div className="page">
        <div className="info">Cargando...</div>
      </div>
    );
  }

  if (!session) return <LoginPage />;
  return <App />;
}

export default function AppRoot() {
  return (
    <AuthProvider>
      <Gate />
    </AuthProvider>
  );
}
