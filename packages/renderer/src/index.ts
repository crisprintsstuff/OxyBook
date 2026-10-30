// SPDX-License-Identifier: AGPL-3.0-only

export { STARTING_ALLOWLIST } from '@oxybook/doc-model';
export {
  atomicSymlink,
  type BuildAssetInput,
  type BuildPageInput,
  type BuildVersionInput,
  type BuildVersionResult,
  buildSiteVersion,
  clearRenderedBodyCache,
  hardlinkTree,
  type SiteBuildWarning,
} from './build.js';
export {
  type ComponentMap,
  type ComponentMapEntry,
  emptyOxybookConfig,
  isExcluded,
  type OxybookConfig,
  parseOxybookConfig,
  type RedirectRule,
  resolveImports,
  type VersionConfig,
} from './config.js';
export {
  ensureLanguagesLoaded,
  getSharedHighlighter,
  highlightCodeToHast,
  normalizeLanguage,
} from './highlight.js';
export {
  applyVersionPrefix,
  type BrokenLinkWarning,
  type LinkResolution,
  normalizePageMap,
  type PageLookupInput,
  resolveAssetLink,
  resolvePageLink,
  StrictBuildError,
} from './links.js';
export {
  buildNavTree,
  type DirConfig,
  type NavItem,
  type NavPageInput,
  parseDirConfig,
} from './nav.js';
export {
  type BuildWarning,
  DEFAULT_ALLOWLIST,
  DEFAULT_DIRECTIVES,
  extractStaticProps,
  type RenderOptions,
  type RenderResult,
  renderPage,
  renderPageSync,
  type SearchDocument,
  type SearchHeading,
  type StaticPropValue,
  type UnparseableWarning,
} from './render.js';
export {
  type BuildEnvironment,
  runSpaceBuild,
  type SpaceBuildResult,
} from './runner.js';
export {
  type DocumentHtmlOptions,
  render404Html,
  renderDocumentHtml,
  renderRedirectHtml,
} from './template.js';
