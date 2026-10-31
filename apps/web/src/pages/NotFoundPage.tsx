import { Link } from 'react-router';
import { useTranslation } from '../i18n';

export function NotFoundPage() {
  const { t } = useTranslation();
  return (
    <div className="flex min-h-[50vh] flex-col items-center justify-center gap-3 text-center">
      <p className="text-5xl font-black opacity-20">404</p>
      <h1 className="text-xl font-bold">{t('errors.notFound')}</h1>
      <Link className="btn btn-primary btn-sm" to="/">
        {t('nav.dashboard')}
      </Link>
    </div>
  );
}
