import update from 'immutability-helper';
import { App, MarkdownView, TFile, TFolder, moment, normalizePath } from 'obsidian';
import Preact, { Dispatch, RefObject, useEffect } from 'preact/compat';
import { StateUpdater, useMemo } from 'preact/hooks';
import { StateManager } from 'src/StateManager';
import { Path } from 'src/dnd/types';
import { getEntityFromPath } from 'src/dnd/util/data';
import {
  InlineField,
  getTaskStatusDone,
  getTaskStatusPreDone,
  toggleTask,
} from 'src/parsers/helpers/inlineMetadata';

import { SearchContextProps } from './context';
import { Board, DataKey, DateColor, Item, Lane, PageData, TagColor } from './types';

export const baseClassName = 'kanban-plugin';

export function noop() {}

const classCache = new Map<string, string>();
export function c(className: string) {
  if (classCache.has(className)) return classCache.get(className);
  const cls = `${baseClassName}__${className}`;
  classCache.set(className, cls);
  return cls;
}

export function generateInstanceId(len: number = 9): string {
  return Math.random()
    .toString(36)
    .slice(2, 2 + len);
}

export function maybeCompleteForMove(
  sourceStateManager: StateManager,
  sourceBoard: Board,
  sourcePath: Path,
  destinationStateManager: StateManager,
  destinationBoard: Board,
  destinationPath: Path,
  item: Item
): { next: Item; replacement?: Item } {
  const sourceParent = getEntityFromPath(sourceBoard, sourcePath.slice(0, -1));
  const destinationParent = getEntityFromPath(destinationBoard, destinationPath.slice(0, -1));

  const oldShouldComplete = sourceParent?.data?.shouldMarkItemsComplete;
  const newShouldComplete = destinationParent?.data?.shouldMarkItemsComplete;

  // If neither the old or new lane set it complete, leave it alone
  if (!oldShouldComplete && !newShouldComplete) return { next: item };

  const isComplete = item.data.checked && item.data.checkChar === getTaskStatusDone();

  // If it already matches the new lane, leave it alone
  if (newShouldComplete === isComplete) return { next: item };

  if (newShouldComplete) {
    item = update(item, { data: { checkChar: { $set: getTaskStatusPreDone() } } });
  }

  const updates = toggleTask(item, destinationStateManager.file);

  if (updates) {
    const [itemStrings, checkChars, thisIndex] = updates;
    let next: Item;
    let replacement: Item;

    itemStrings.forEach((str, i) => {
      if (i === thisIndex) {
        next = destinationStateManager.getNewItem(str, checkChars[i]);
      } else {
        replacement = destinationStateManager.getNewItem(str, checkChars[i]);
      }
    });

    return { next, replacement };
  }

  // It's different, update it
  return {
    next: update(item, {
      data: {
        checked: {
          $set: newShouldComplete,
        },
        checkChar: {
          $set: newShouldComplete ? getTaskStatusDone() : ' ',
        },
      },
    }),
  };
}

export function useIMEInputProps() {
  const isComposingRef = Preact.useRef<boolean>(false);

  return {
    // Note: these are lowercased because we use preact
    // See: https://github.com/preactjs/preact/issues/3003
    oncompositionstart: () => {
      isComposingRef.current = true;
    },
    oncompositionend: () => {
      isComposingRef.current = false;
    },
    getShouldIMEBlockAction: () => {
      return isComposingRef.current;
    },
  };
}

export const templaterDetectRegex = /<%/;

export async function applyTemplate(stateManager: StateManager, templatePath?: string) {
  const templateFile = templatePath
    ? stateManager.app.vault.getAbstractFileByPath(templatePath)
    : null;

  if (templateFile && templateFile instanceof TFile) {
    let activeView = stateManager.app.workspace.getActiveViewOfType(MarkdownView);

    try {
      if (!activeView) {
        activeView = await waitForActiveMarkdownView(stateManager.app);
      }

      if (!activeView) {
        throw new Error('Unable to locate an active markdown view to apply the template.');
      }

      // Force the view to source mode, if needed
      if (activeView?.getMode() !== 'source') {
        await activeView.setState(
          {
            ...activeView.getState(),
            mode: 'source',
          },
          { history: false }
        );
      }

      const {
        templatesEnabled,
        templaterEnabled,
        templatesPlugin,
        templaterPlugin,
      } = getTemplatePlugins(stateManager.app);

      const templateContent = await stateManager.app.vault.read(templateFile);

      // If both plugins are enabled, attempt to detect templater first
      if (templatesEnabled && templaterEnabled) {
        if (templaterDetectRegex.test(templateContent)) {
          const applied = await tryApplyTemplaterTemplate(templaterPlugin, templateFile);

          if (applied) {
            return;
          }
        }

        const applied = await tryApplyTemplatesPlugin(
          templatesPlugin,
          templateFile,
          activeView
        );

        if (applied) {
          return;
        }

        const templaterApplied = await tryApplyTemplaterTemplate(
          templaterPlugin,
          templateFile
        );

        if (templaterApplied) {
          return;
        }
      } else if (templatesEnabled) {
        const applied = await tryApplyTemplatesPlugin(
          templatesPlugin,
          templateFile,
          activeView
        );

        if (applied) {
          return;
        }
      } else if (templaterEnabled) {
        const applied = await tryApplyTemplaterTemplate(templaterPlugin, templateFile);

        if (applied) {
          return;
        }
      }

      // No template plugins enabled or all integrations failed; append the template directly.
      const activeFile = stateManager.app.workspace.getActiveFile();

      if (activeFile) {
        await stateManager.app.vault.modify(activeFile, templateContent);
      }
    } catch (e) {
      console.error(e);
      stateManager.setError(e);
    }
  }
}

export function getDefaultDateFormat(app: App) {
  const internalPlugins = (app as any).internalPlugins.plugins;
  const dailyNotesEnabled = internalPlugins['daily-notes']?.enabled;
  const dailyNotesValue = internalPlugins['daily-notes']?.instance.options.format;
  const nlDatesValue = (app as any).plugins.plugins['nldates-obsidian']?.settings.format;
  const templatesEnabled = internalPlugins.templates?.enabled;
  const templatesValue = internalPlugins.templates?.instance.options.dateFormat;

  return (
    (dailyNotesEnabled && dailyNotesValue) ||
    nlDatesValue ||
    (templatesEnabled && templatesValue) ||
    'YYYY-MM-DD'
  );
}

export function getDefaultTimeFormat(app: App) {
  const internalPlugins = (app as any).internalPlugins.plugins;
  const nlDatesValue = (app as any).plugins.plugins['nldates-obsidian']?.settings.timeFormat;
  const templatesEnabled = internalPlugins.templates?.enabled;
  const templatesValue = internalPlugins.templates?.instance.options.timeFormat;

  return nlDatesValue || (templatesEnabled && templatesValue) || 'HH:mm';
}

const reRegExChar = /[\\^$.*+?()[\]{}|]/g;
const reHasRegExChar = RegExp(reRegExChar.source);

export function escapeRegExpStr(str: string) {
  return str && reHasRegExChar.test(str) ? str.replace(reRegExChar, '\\$&') : str || '';
}

export function getTemplatePlugins(app: App) {
  const internalPlugins = (app as any).internalPlugins;
  const appPlugins = (app as any).plugins;

  const enabledTemplatesPlugin = internalPlugins?.getEnabledPluginById?.('templates');
  const templatesPlugin =
    enabledTemplatesPlugin ?? internalPlugins?.getPluginById?.('templates') ?? internalPlugins?.plugins?.templates;
  const templatesEnabled = Boolean(
    enabledTemplatesPlugin ?? templatesPlugin?.enabled ?? internalPlugins?.enabledPlugins?.has?.('templates')
  );
  const templatesInstance = templatesPlugin?.instance ?? templatesPlugin;

  const templaterPlugin =
    appPlugins?.getPlugin?.('templater-obsidian') ?? appPlugins?.plugins?.['templater-obsidian'] ?? null;
  const templaterEnabled = Boolean(
    appPlugins?.enabledPlugins?.has?.('templater-obsidian') ?? templaterPlugin?.enabled
  );
  const templaterApi = templaterPlugin?.templater ?? templaterPlugin?.api ?? templaterPlugin ?? null;

  const templateFolder = templatesEnabled
    ? templatesInstance?.options?.folder ?? templatesInstance?.options?.templateFolder
    : templaterPlugin?.settings?.template_folder ?? templaterPlugin?.options?.template_folder;

  return {
    templatesPlugin: templatesInstance,
    templatesEnabled,
    templaterPlugin: templaterApi,
    templaterEnabled,
    templaterEmptyFileTemplate: templaterPlugin?.settings?.empty_file_template,
    templateFolder,
  };
}

async function tryApplyTemplatesPlugin(
  templatesPlugin: any,
  templateFile: TFile,
  activeView: MarkdownView | null
) {
  if (!templatesPlugin) {
    return false;
  }

  const instance = templatesPlugin.instance ?? templatesPlugin;
  const candidateFns = [
    instance?.insertTemplate,
    instance?.insert_template,
    instance?.insertTemplateForFile,
    instance?.insert_template_for_file,
  ].filter((fn) => typeof fn === 'function');

  let lastError: unknown;

  for (const fn of candidateFns) {
    try {
      const bound = fn.bind(instance);

      if (fn.length >= 2) {
        if (activeView) {
          await bound(templateFile, activeView);
          return true;
        }

        await bound(templateFile, undefined);
        return true;
      }

      if (fn.length === 1) {
        await bound(templateFile);
        return true;
      }

      await bound();
      return true;
    } catch (err) {
      lastError = err;

      if (fn.length >= 2) {
        try {
          const bound = fn.bind(instance);
          await bound(templateFile);
          return true;
        } catch (retryError) {
          lastError = retryError;
        }
      }
    }
  }

  if (lastError) {
    console.error('Templates plugin failed to insert template.', lastError);
  }

  return false;
}

async function tryApplyTemplaterTemplate(templaterPlugin: any, templateFile: TFile) {
  if (!templaterPlugin) {
    return false;
  }

  const candidateFns: Array<{ fn: (...args: any[]) => any; ctx: any }> = [];

  if (typeof templaterPlugin?.append_template_to_active_file === 'function') {
    candidateFns.push({ fn: templaterPlugin.append_template_to_active_file, ctx: templaterPlugin });
  }

  if (typeof templaterPlugin?.appendTemplateToActiveFile === 'function') {
    candidateFns.push({ fn: templaterPlugin.appendTemplateToActiveFile, ctx: templaterPlugin });
  }

  if (typeof templaterPlugin?.templater?.append_template_to_active_file === 'function') {
    candidateFns.push({
      fn: templaterPlugin.templater.append_template_to_active_file,
      ctx: templaterPlugin.templater,
    });
  }

  if (typeof templaterPlugin?.templater?.appendTemplateToActiveFile === 'function') {
    candidateFns.push({
      fn: templaterPlugin.templater.appendTemplateToActiveFile,
      ctx: templaterPlugin.templater,
    });
  }

  let lastError: unknown;

  for (const { fn, ctx } of candidateFns) {
    try {
      await fn.call(ctx, templateFile);
      return true;
    } catch (err) {
      lastError = err;
    }
  }

  if (lastError) {
    console.error('Templater plugin failed to append template.', lastError);
  }

  return false;
}

async function waitForActiveMarkdownView(app: App, timeout = 2000, interval = 50) {
  const start = Date.now();

  let view = app.workspace.getActiveViewOfType(MarkdownView);

  while (!view && Date.now() - start < timeout) {
    await new Promise((resolve) => setTimeout(resolve, interval));
    view = app.workspace.getActiveViewOfType(MarkdownView);
  }

  return view;
}

export async function createMarkdownFileWithFallback(
  app: App,
  folder: TFolder,
  title: string
): Promise<TFile> {
  const fileManager = app.fileManager as any;

  if (typeof fileManager?.createNewMarkdownFile === 'function') {
    return fileManager.createNewMarkdownFile(folder, title);
  }

  if (typeof fileManager?.createMarkdownFile === 'function') {
    return fileManager.createMarkdownFile(folder, title);
  }

  const filename = title.endsWith('.md') ? title : `${title}.md`;
  const folderPath = folder?.path ? `${folder.path}/${filename}` : filename;
  const normalizedPath = normalizePath(folderPath);

  return app.vault.create(normalizedPath, '');
}

export function getTagColorFn(tagColors: TagColor[]) {
  const tagMap = (tagColors || []).reduce<Record<string, TagColor>>((total, current) => {
    if (!current.tagKey) return total;
    total[current.tagKey] = current;
    return total;
  }, {});

  return (tag: string) => {
    if (tagMap[tag]) return tagMap[tag];
    return null;
  };
}

export function useGetTagColorFn(stateManager: StateManager): (tag: string) => TagColor {
  const tagColors = stateManager.useSetting('tag-colors');
  return useMemo(() => getTagColorFn(tagColors), [tagColors]);
}

export function getDateColorFn(dateColors: DateColor[]) {
  const orders = (dateColors || []).map<[moment.Moment | 'today' | 'before' | 'after', DateColor]>(
    (c) => {
      if (c.isToday) {
        return ['today', c];
      }

      if (c.isBefore) {
        return ['before', c];
      }

      if (c.isAfter) {
        return ['after', c];
      }

      const modifier = c.direction === 'after' ? 1 : -1;
      const date = moment();

      date.add(c.distance * modifier, c.unit);

      return [date, c];
    }
  );

  const now = moment();
  orders.sort((a, b) => {
    if (a[0] === 'today') {
      return typeof b[0] === 'string' ? -1 : b[0].isSame(now, 'day') ? 1 : -1;
    }
    if (b[0] === 'today') {
      return typeof a[0] === 'string' ? 1 : a[0].isSame(now, 'day') ? -1 : 1;
    }

    if (a[0] === 'after') return 1;
    if (a[0] === 'before') return 1;
    if (b[0] === 'after') return -1;
    if (b[0] === 'before') return -1;

    return a[0].isBefore(b[0]) ? -1 : 1;
  });

  return (date: moment.Moment) => {
    const now = moment();
    const result = orders.find((o) => {
      const key = o[1];
      if (key.isToday) return date.isSame(now, 'day');
      if (key.isAfter) return date.isAfter(now);
      if (key.isBefore) return date.isBefore(now);

      let granularity: moment.unitOfTime.StartOf = 'days';

      if (key.unit === 'hours') {
        granularity = 'hours';
      }

      if (key.direction === 'before') {
        return date.isBetween(o[0], now, granularity, '[]');
      }

      return date.isBetween(now, o[0], granularity, '[]');
    });

    if (result) {
      return result[1];
    }

    return null;
  };
}

export function useGetDateColorFn(
  stateManager: StateManager
): (date: moment.Moment) => DateColor | null {
  const dateColors = stateManager.useSetting('date-colors');
  return useMemo(() => getDateColorFn(dateColors), [dateColors]);
}

export function parseMetadataWithOptions(data: InlineField, metadataKeys: DataKey[]): PageData {
  const options = metadataKeys.find((opts) => opts.metadataKey === data.key);

  return options
    ? {
        ...options,
        value: data.value,
      }
    : {
        containsMarkdown: false,
        label: data.key,
        metadataKey: data.key,
        shouldHideLabel: false,
        value: data.value,
      };
}

export function useOnMount(refs: RefObject<HTMLElement>[], cb: () => void, onUnmount?: () => void) {
  useEffect(() => {
    let complete = 0;
    let unmounted = false;
    const onDone = () => {
      if (unmounted) return;
      if (++complete === refs.length) {
        cb();
      }
    };
    for (const ref of refs) ref.current?.onNodeInserted(onDone, true);
    return () => {
      unmounted = true;
      onUnmount();
    };
  }, []);
}

export function useSearchValue(
  board: Board,
  query: string,
  setSearchQuery: Dispatch<StateUpdater<string>>,
  setDebouncedSearchQuery: Dispatch<StateUpdater<string>>,
  setIsSearching: Dispatch<StateUpdater<boolean>>
) {
  return useMemo<SearchContextProps>(() => {
    query = query.trim().toLocaleLowerCase();

    const lanes = new Set<Lane>();
    const items = new Set<Item>();

    if (query) {
      board.children.forEach((lane) => {
        let laneMatched = false;
        lane.children.forEach((item) => {
          if (item.data.titleSearch.includes(query)) {
            laneMatched = true;
            items.add(item);
          }
        });
        if (laneMatched) lanes.add(lane);
      });
    }

    return {
      lanes,
      items,
      query,
      search: (query, immediate) => {
        if (!query) {
          setIsSearching(false);
          setSearchQuery('');
          setDebouncedSearchQuery('');
        }
        setIsSearching(true);
        if (immediate) {
          setSearchQuery(query);
          setDebouncedSearchQuery(query);
        } else {
          setSearchQuery(query);
        }
      },
    };
  }, [board, query, setSearchQuery, setDebouncedSearchQuery]);
}
