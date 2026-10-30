// SPDX-License-Identifier: Apache-2.0

export { buildThemeClientScript } from './client.js';
export {
  buildThemeStyles,
  escapeHtml,
  findPrevNextPages,
  flattenNavPages,
  render404Document,
  renderPageDocument,
  renderRedirectDocument,
} from './layout.js';
export { DEFAULT_THEME_CSS } from './styles.js';
export type {
  ThemeConfig,
  ThemeHeaderLink,
  ThemeHeading,
  ThemeNavItem,
  ThemePageLink,
  ThemePageProps,
  ThemeVersionLink,
} from './types.js';
