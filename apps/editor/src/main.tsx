// SPDX-License-Identifier: AGPL-3.0-only

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { EditorApi } from './api.ts';
import { routeFromPath } from './model.ts';
import './styles.css';

const root = document.getElementById('root');
const route = routeFromPath(window.location.pathname);
if (root) {
  createRoot(root).render(
    <StrictMode>
      {route ? (
        <App api={new EditorApi(route.org, route.space)} />
      ) : (
        <p className="fatal">The editor lives at /orgs/&lt;org&gt;/spaces/&lt;space&gt;/edit.</p>
      )}
    </StrictMode>,
  );
}
