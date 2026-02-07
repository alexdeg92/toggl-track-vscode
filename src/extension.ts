import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import axios from 'axios';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// Monday.com API token - must be set via MONDAY_TOKEN env var or settings
function getMondayToken(): string {
  return vscode.workspace.getConfiguration('togglTrackAuto').get<string>('mondayApiToken') || process.env.MONDAY_TOKEN || '';
}

// ========== Monday.com Task Integration ==========

const MONDAY_API_URL = 'https://api.monday.com/v2';
const MONDAY_BOARD_URL_BASE = 'https://pivot584586.monday.com/boards';

interface MondayTask {
  id: string;
  name: string;
  boardId: string;
}

interface BranchTaskMapping {
  [branch: string]: {
    taskId: string;
    taskName: string;
    boardId: string;
    url: string;
  };
}

// ========== Monday.com Detailed Task Types ==========

interface MondayColumnValue {
  id: string;
  type?: string;
  text: string;
  title?: string;
  column?: { title: string };
}

interface MondayAsset {
  id: string;
  name: string;
  url: string;
  file_extension: string;
  public_url?: string;
}

interface MondayReply {
  text_body: string;
  created_at: string;
  creator: { name: string; photo_thumb_small?: string };
}

interface MondayUpdate {
  text_body: string;
  created_at: string;
  creator: { name: string; photo_thumb_small?: string };
  assets?: MondayAsset[];
  replies?: MondayReply[];
}

interface MondaySubItem {
  id: string;
  name: string;
  column_values: MondayColumnValue[];
}

interface MondayDetailedTask {
  id: string;
  name: string;
  group: { title: string };
  column_values: MondayColumnValue[];
  updates: MondayUpdate[];
  subitems: MondaySubItem[];
  boardId: string;
}

function getMondayBoardId(): string {
  return vscode.workspace.getConfiguration('togglTrackAuto').get<string>('mondayBoardId') || '4176868787';
}

function getMondayTaskUrl(boardId: string, taskId: string): string {
  return `${MONDAY_BOARD_URL_BASE}/${boardId}/pulses/${taskId}`;
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 60);
}

function getWorkspaceRoot(): string | null {
  const folders = vscode.workspace.workspaceFolders;
  return folders && folders.length > 0 ? folders[0].uri.fsPath : null;
}

function getMondayTasksFilePath(): string | null {
  const root = getWorkspaceRoot();
  if (!root) return null;
  return path.join(root, '.vscode', 'monday-tasks.json');
}

function readBranchTaskMappings(): BranchTaskMapping {
  const filePath = getMondayTasksFilePath();
  if (!filePath) return {};
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    }
  } catch {
    // ignore
  }
  return {};
}

function writeBranchTaskMappings(mappings: BranchTaskMapping): void {
  const filePath = getMondayTasksFilePath();
  if (!filePath) return;
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(filePath, JSON.stringify(mappings, null, 2));

  // Ensure .vscode/monday-tasks.json is in .gitignore
  const root = getWorkspaceRoot();
  if (root) {
    ensureGitignoreEntry(root, '.vscode/monday-tasks.json');
  }
}

function ensureGitignoreEntry(root: string, entry: string): void {
  const gitignorePath = path.join(root, '.gitignore');
  try {
    let content = '';
    if (fs.existsSync(gitignorePath)) {
      content = fs.readFileSync(gitignorePath, 'utf-8');
    }
    if (!content.includes(entry)) {
      const newline = content.endsWith('\n') ? '' : '\n';
      fs.writeFileSync(gitignorePath, content + newline + entry + '\n');
    }
  } catch {
    // best effort
  }
}

// ========== Fetch Detailed Monday Task ==========

async function fetchDetailedMondayTask(taskId: string): Promise<MondayDetailedTask | null> {
  const token = getMondayToken();
  if (!token) return null;

  try {
    const query = `
      query {
        items(ids: [${taskId}]) {
          id
          name
          group { title }
          column_values {
            id
            type
            text
            column { title }
          }
          updates(limit: 10) {
            text_body
            created_at
            creator { name photo_thumb_small }
            assets {
              id
              name
              url
              file_extension
              public_url
            }
            replies {
              text_body
              created_at
              creator { name photo_thumb_small }
            }
          }
          subitems {
            id
            name
            column_values {
              id
              type
              text
              column { title }
            }
          }
        }
      }
    `;

    const response = await axios.post(MONDAY_API_URL, { query }, {
      headers: {
        'Authorization': token,
        'Content-Type': 'application/json',
      },
    });

    const items = response.data?.data?.items;
    if (!items || items.length === 0) return null;

    const item = items[0];
    return {
      ...item,
      boardId: getMondayBoardId(),
    };
  } catch (error) {
    console.error('Failed to fetch detailed Monday task:', error);
    return null;
  }
}

// ========== Extract task ID from branch ==========

function extractTaskIdFromBranch(branch: string): string | null {
  const config = vscode.workspace.getConfiguration('togglTrackAuto');
  const pattern = config.get<string>('branchPattern') || '(\\d{6,})';
  const regex = new RegExp(pattern);
  const match = branch.match(regex);
  return match ? match[1] : null;
}

async function getCurrentBranchName(): Promise<string | null> {
  // Try VS Code's built-in Git extension API first (works in Cursor too)
  try {
    const gitExtension = vscode.extensions.getExtension('vscode.git');
    if (gitExtension) {
      const git = gitExtension.isActive ? gitExtension.exports : await gitExtension.activate();
      const api = git.getAPI(1);
      if (api && api.repositories.length > 0) {
        const repo = api.repositories[0];
        const head = repo.state?.HEAD;
        if (head?.name) {
          return head.name;
        }
      }
    }
  } catch {
    // Fall through to exec fallback
  }

  // Fallback: exec git command
  const root = getWorkspaceRoot();
  if (!root) return null;
  try {
    const { stdout } = await execAsync('git rev-parse --abbrev-ref HEAD', { cwd: root });
    return stdout.trim();
  } catch {
    return null;
  }
}

function resolveTaskIdForBranch(branch: string): string | null {
  // First try branch name pattern
  const fromBranch = extractTaskIdFromBranch(branch);
  if (fromBranch) return fromBranch;

  // Fallback: check .vscode/monday-tasks.json mapping
  const mappings = readBranchTaskMappings();
  const mapping = mappings[branch];
  if (mapping?.taskId) return mapping.taskId;

  return null;
}

// ========== Helper: get column value ==========

function getColumnValue(task: MondayDetailedTask, titleOrId: string): string {
  const col = task.column_values.find(
    c => c.id === titleOrId || (c.column?.title || '').toLowerCase() === titleOrId.toLowerCase()
  );
  return col?.text || '';
}

// ========== Monday.com Task TreeView ==========

class MondayTaskItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly children?: MondayTaskItem[],
    options?: {
      description?: string;
      tooltip?: string | vscode.MarkdownString;
      iconPath?: vscode.ThemeIcon;
      command?: vscode.Command;
      contextValue?: string;
    }
  ) {
    super(label, collapsibleState);
    if (options?.description) this.description = options.description;
    if (options?.tooltip) this.tooltip = options.tooltip;
    if (options?.iconPath) this.iconPath = options.iconPath;
    if (options?.command) this.command = options.command;
    if (options?.contextValue) this.contextValue = options.contextValue;
  }
}

class MondayTaskTreeProvider implements vscode.TreeDataProvider<MondayTaskItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<MondayTaskItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private task: MondayDetailedTask | null = null;
  private taskUrl: string = '';
  private noTaskLinked: boolean = true;

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  setTask(task: MondayDetailedTask | null, url: string): void {
    this.task = task;
    this.taskUrl = url;
    this.noTaskLinked = !task;
    this.refresh();
  }

  setNoTask(): void {
    this.task = null;
    this.taskUrl = '';
    this.noTaskLinked = true;
    this.refresh();
  }

  getTreeItem(element: MondayTaskItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: MondayTaskItem): MondayTaskItem[] {
    if (!this.task) {
      if (this.noTaskLinked) {
        return []; // Will show the welcome content
      }
      return [];
    }

    // If we have a parent element, return its children
    if (element) {
      return element.children || [];
    }

    // Root level items
    const items: MondayTaskItem[] = [];
    const task = this.task;

    // Task name (header)
    items.push(new MondayTaskItem(
      task.name,
      vscode.TreeItemCollapsibleState.None,
      undefined,
      {
        description: `#${task.id}`,
        iconPath: new vscode.ThemeIcon('tasklist'),
        tooltip: task.name,
      }
    ));

    // Status (colored by state)
    const status = getColumnValue(task, 'status9') || getColumnValue(task, 'Status') || getColumnValue(task, 'status');
    if (status) {
      const statusLower = status.toLowerCase();
      const statusColor = statusLower.includes('done') ? 'charts.green' 
        : statusLower.includes('progress') ? 'charts.blue'
        : statusLower.includes('review') ? 'charts.purple'
        : statusLower.includes('stuck') || statusLower.includes('block') ? 'charts.red'
        : 'charts.yellow';
      items.push(new MondayTaskItem(
        'Status',
        vscode.TreeItemCollapsibleState.None,
        undefined,
        {
          description: status,
          iconPath: new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor(statusColor)),
        }
      ));
    }

    // Priority (colored by urgency)
    const priority = getColumnValue(task, 'dup__of_priority_mkkassyk') || getColumnValue(task, 'Priority') || getColumnValue(task, 'priority');
    if (priority) {
      const prioLower = priority.toLowerCase();
      const prioColor = prioLower.includes('critical') || prioLower.includes('p1') ? 'charts.red'
        : prioLower.includes('urgent') || prioLower.includes('p2') ? 'charts.orange'
        : prioLower.includes('medium') || prioLower.includes('p3') ? 'charts.yellow'
        : 'charts.green';
      items.push(new MondayTaskItem(
        'Priority',
        vscode.TreeItemCollapsibleState.None,
        undefined,
        {
          description: priority,
          iconPath: new vscode.ThemeIcon('flame', new vscode.ThemeColor(prioColor)),
        }
      ));
    }

    // Assigned person(s)
    const person = getColumnValue(task, 'person') || getColumnValue(task, 'Person') || getColumnValue(task, 'people');
    if (person) {
      items.push(new MondayTaskItem(
        'Assigned',
        vscode.TreeItemCollapsibleState.None,
        undefined,
        {
          description: person,
          iconPath: new vscode.ThemeIcon('person', new vscode.ThemeColor('charts.green')),
        }
      ));
    }

    // Group
    if (task.group?.title) {
      items.push(new MondayTaskItem(
        'Group',
        vscode.TreeItemCollapsibleState.None,
        undefined,
        {
          description: task.group.title,
          iconPath: new vscode.ThemeIcon('folder', new vscode.ThemeColor('charts.purple')),
        }
      ));
    }

    // Description (from column_values - look for long text or text columns)
    const descriptionCol = task.column_values.find(
      c => c.id === 'long_text' || c.id === 'text' || (c.column?.title || "").toLowerCase().includes('description') || (c.column?.title || "").toLowerCase().includes('notes')
    );
    if (descriptionCol?.text) {
      const lines = descriptionCol.text.split('\n').filter(l => l.trim());
      const descChildren = lines.map(line =>
        new MondayTaskItem(
          line.substring(0, 120),
          vscode.TreeItemCollapsibleState.None,
          undefined,
          { tooltip: line }
        )
      );
      items.push(new MondayTaskItem(
        'Description',
        vscode.TreeItemCollapsibleState.Collapsed,
        descChildren,
        { iconPath: new vscode.ThemeIcon('note') }
      ));
    }

    // Updates — expand below to show full content (word-wrapped)
    if (task.updates && task.updates.length > 0) {
      const wrapText = (text: string, width: number = 45): string[] => {
        const result: string[] = [];
        for (const line of text.split('\n')) {
          if (!line.trim()) { result.push(''); continue; }
          const words = line.split(' ');
          let current = '';
          for (const word of words) {
            if (current.length + word.length + 1 > width && current) {
              result.push(current);
              current = word;
            } else {
              current = current ? current + ' ' + word : word;
            }
          }
          if (current) result.push(current);
        }
        return result;
      };

      const updateChildren = task.updates.map(update => {
        const date = new Date(update.created_at).toLocaleDateString();
        const author = update.creator?.name || 'Unknown';
        const body = (update.text_body || '').trim();
        // Word-wrap each line to fit sidebar
        const wrappedLines = wrapText(body);
        const lineChildren: MondayTaskItem[] = [];
        
        // Add a separator line first
        wrappedLines.forEach((line: string) => {
          if (!line.trim()) {
            // Empty line = paragraph break
            lineChildren.push(new MondayTaskItem(
              ' ',
              vscode.TreeItemCollapsibleState.None,
              undefined,
              { iconPath: new vscode.ThemeIcon('blank') }
            ));
          } else {
            lineChildren.push(new MondayTaskItem(
              line,
              vscode.TreeItemCollapsibleState.None,
              undefined,
              {
                tooltip: new vscode.MarkdownString(line),
                iconPath: new vscode.ThemeIcon('dash', new vscode.ThemeColor('charts.blue')),
              }
            ));
          }
        });

        return new MondayTaskItem(
          `${author} — ${date}`,
          vscode.TreeItemCollapsibleState.Collapsed,
          lineChildren,
          {
            description: body.substring(0, 50).replace(/\n/g, ' ') + (body.length > 50 ? '...' : ''),
            tooltip: new vscode.MarkdownString(`**${author}** — ${date}\n\n---\n\n${body.replace(/\n/g, '\n\n')}`),
            iconPath: new vscode.ThemeIcon('comment', new vscode.ThemeColor('charts.blue')),
          }
        );
      });
      items.push(new MondayTaskItem(
        '━━ Updates',
        vscode.TreeItemCollapsibleState.Collapsed,
        updateChildren,
        {
          description: `(${task.updates.length}) ━━━━━━━━━━━━`,
          iconPath: new vscode.ThemeIcon('comment-discussion', new vscode.ThemeColor('charts.blue')),
        }
      ));
    }

    // Sub-items
    if (task.subitems && task.subitems.length > 0) {
      const subChildren = task.subitems.map(sub => {
        const subStatus = sub.column_values.find(
          c => c.id.includes('status') || (c.column?.title || "").toLowerCase() === 'status'
        )?.text || '';
        const isDone = subStatus.toLowerCase().includes('done') || subStatus.toLowerCase().includes('complete');
        return new MondayTaskItem(
          sub.name,
          vscode.TreeItemCollapsibleState.None,
          undefined,
          {
            description: subStatus,
            iconPath: new vscode.ThemeIcon(
              isDone ? 'pass-filled' : 'circle-outline',
              new vscode.ThemeColor(isDone ? 'charts.green' : subStatus.toLowerCase().includes('progress') ? 'charts.blue' : 'charts.yellow')
            ),
            tooltip: `${sub.name} — ${subStatus}`,
          }
        );
      });
      items.push(new MondayTaskItem(
        '━━ Sub-items',
        vscode.TreeItemCollapsibleState.Expanded,
        subChildren,
        {
          description: `(${task.subitems.length}) ━━━━━━━━━━`,
          iconPath: new vscode.ThemeIcon('list-tree', new vscode.ThemeColor('charts.green')),
        }
      ));
    }

    // Link to Monday.com
    if (this.taskUrl) {
      items.push(new MondayTaskItem(
        'Open in Monday.com',
        vscode.TreeItemCollapsibleState.None,
        undefined,
        {
          iconPath: new vscode.ThemeIcon('link-external'),
          command: {
            command: 'vscode.open',
            title: 'Open in Monday.com',
            arguments: [vscode.Uri.parse(this.taskUrl)],
          },
        }
      ));
    }

    return items;
  }
}

// ========== AI Context Files ==========

function generateTaskMarkdown(task: MondayDetailedTask, url: string): string {
  const status = getColumnValue(task, 'status9') || getColumnValue(task, 'Status') || getColumnValue(task, 'status') || 'Unknown';
  const priority = getColumnValue(task, 'dup__of_priority_mkkassyk') || getColumnValue(task, 'Priority') || getColumnValue(task, 'priority') || 'Unknown';
  const person = getColumnValue(task, 'person') || getColumnValue(task, 'Person') || getColumnValue(task, 'people') || 'Unassigned';
  const group = task.group?.title || 'Unknown';

  // Description from column values
  const descriptionCol = task.column_values.find(
    c => c.id === 'long_text' || c.id === 'text' || (c.column?.title || "").toLowerCase().includes('description') || (c.column?.title || "").toLowerCase().includes('notes')
  );
  const description = descriptionCol?.text || '';

  let md = `# Task: ${task.name}\n\n`;
  md += `**ID:** ${task.id}\n`;
  md += `**Status:** ${status}\n`;
  md += `**Priority:** ${priority}\n`;
  md += `**Assigned:** ${person}\n`;
  md += `**Group:** ${group}\n`;
  md += `**Monday URL:** ${url}\n`;

  if (description) {
    md += `\n## Description\n\n${description}\n`;
  }

  if (task.updates && task.updates.length > 0) {
    md += `\n## Updates\n`;
    for (const update of task.updates) {
      const date = new Date(update.created_at).toLocaleDateString();
      const author = update.creator?.name || 'Unknown';
      md += `\n### ${author} — ${date}\n\n${update.text_body || '(no text)'}\n`;
    }
  }

  if (task.subitems && task.subitems.length > 0) {
    md += `\n## Sub-items\n\n`;
    for (const sub of task.subitems) {
      const subStatus = sub.column_values.find(
        c => c.id.includes('status') || (c.column?.title || "").toLowerCase() === 'status'
      )?.text || '';
      const isDone = subStatus.toLowerCase().includes('done') || subStatus.toLowerCase().includes('complete');
      md += `- [${isDone ? 'x' : ' '}] ${sub.name} (${subStatus || 'No status'})\n`;
    }
  }

  return md;
}

function generateContextMarkdown(task: MondayDetailedTask, url: string): string {
  const descriptionCol = task.column_values.find(
    c => c.id === 'long_text' || c.id === 'text' || (c.column?.title || "").toLowerCase().includes('description') || (c.column?.title || "").toLowerCase().includes('notes')
  );
  const description = descriptionCol?.text || 'No description available.';

  // Extract requirements from updates
  let requirements = '';
  if (task.updates && task.updates.length > 0) {
    const updateTexts = task.updates
      .map(u => u.text_body)
      .filter(Boolean)
      .join('\n\n');
    if (updateTexts) {
      requirements = updateTexts;
    }
  }

  let md = `# Monday.com Task Context\n\n`;
  md += `You are working on: ${task.name}\n`;
  md += `Monday URL: ${url}\n`;
  md += `\n## What needs to be done\n\n${description}\n`;

  if (requirements) {
    md += `\n## Requirements\n\n${requirements}\n`;
  }

  if (task.subitems && task.subitems.length > 0) {
    md += `\n## Sub-tasks\n\n`;
    for (const sub of task.subitems) {
      const subStatus = sub.column_values.find(
        c => c.id.includes('status') || (c.column?.title || "").toLowerCase() === 'status'
      )?.text || '';
      const isDone = subStatus.toLowerCase().includes('done') || subStatus.toLowerCase().includes('complete');
      md += `- [${isDone ? 'x' : ' '}] ${sub.name}\n`;
    }
  }

  return md;
}

async function writeContextFiles(task: MondayDetailedTask, url: string): Promise<void> {
  const root = getWorkspaceRoot();
  if (!root) return;

  const mondayDir = path.join(root, 'monday');

  // Create monday/ directory if needed
  if (!fs.existsSync(mondayDir)) {
    fs.mkdirSync(mondayDir, { recursive: true });
  }

  // Write TASK.md
  const taskMd = generateTaskMarkdown(task, url);
  fs.writeFileSync(path.join(mondayDir, 'TASK.md'), taskMd, 'utf-8');

  // Write CONTEXT.md
  const contextMd = generateContextMarkdown(task, url);
  fs.writeFileSync(path.join(mondayDir, 'CONTEXT.md'), contextMd, 'utf-8');

  // Ensure monday/ is in .gitignore
  ensureGitignoreEntry(root, 'monday/');
}

function clearContextFiles(): void {
  const root = getWorkspaceRoot();
  if (!root) return;

  const mondayDir = path.join(root, 'monday');
  if (fs.existsSync(mondayDir)) {
    const taskFile = path.join(mondayDir, 'TASK.md');
    const contextFile = path.join(mondayDir, 'CONTEXT.md');
    if (fs.existsSync(taskFile)) fs.unlinkSync(taskFile);
    if (fs.existsSync(contextFile)) fs.unlinkSync(contextFile);
  }
}

// ========== Monday Sidebar Controller ==========

// ========== Monday.com Webview Sidebar ==========

class MondayWebviewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'togglMondayWebview';
  private _view?: vscode.WebviewView;
  private _task: MondayDetailedTask | null = null;
  private _url: string = '';

  constructor(private readonly _extensionUri: vscode.Uri) {}

  resolveWebviewView(webviewView: vscode.WebviewView) {
    this._view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    this._updateWebview();
  }

  setTask(task: MondayDetailedTask | null, url: string) {
    this._task = task;
    this._url = url;
    this._updateWebview();
  }

  setNoTask() {
    this._task = null;
    this._url = '';
    this._updateWebview();
  }

  private _updateWebview() {
    if (!this._view) return;
    this._view.webview.html = this._getHtml();
  }

  private _getHtml(): string {
    const task = this._task;
    if (!task) {
      return [
        '<!DOCTYPE html><html><head><style>',
        'body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 16px; font-size: 13px; }',
        '.empty { opacity: 0.5; text-align: center; margin-top: 30px; }',
        '</style></head><body>',
        '<p class="empty">No Monday.com task linked<br>to the current branch.</p>',
        '</body></html>'
      ].join('\n');
    }

    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

    const status = getColumnValue(task, 'status9') || getColumnValue(task, 'Status') || '';
    const priority = getColumnValue(task, 'dup__of_priority_mkkassyk') || getColumnValue(task, 'Priority') || '';
    const person = getColumnValue(task, 'person') || getColumnValue(task, 'Person') || '';
    const group = task.group?.title || '';

    const statusColor = status.toLowerCase().includes('done') ? '#4caf50'
      : status.toLowerCase().includes('progress') ? '#2196f3'
      : status.toLowerCase().includes('review') ? '#9c27b0'
      : status.toLowerCase().includes('stuck') ? '#f44336' : '#ff9800';
    const prioColor = priority.toLowerCase().includes('critical') || priority.toLowerCase().includes('p1') ? '#f44336'
      : priority.toLowerCase().includes('urgent') || priority.toLowerCase().includes('p2') ? '#ff9800'
      : priority.toLowerCase().includes('medium') ? '#ffeb3b' : '#4caf50';

    // Meta rows
    const metaRows: string[] = [];
    if (status) metaRows.push('<div class="meta-row"><span class="dot" style="background:' + statusColor + '"></span><span class="meta-label">Status</span><span class="meta-val">' + esc(status) + '</span></div>');
    if (priority) metaRows.push('<div class="meta-row"><span class="icon">\u{1F525}</span><span class="meta-label">Priority</span><span class="meta-val" style="color:' + prioColor + '">' + esc(priority) + '</span></div>');
    if (person) metaRows.push('<div class="meta-row"><span class="icon">\u{1F464}</span><span class="meta-label">Assigned</span><span class="meta-val">' + esc(person) + '</span></div>');
    if (group) metaRows.push('<div class="meta-row"><span class="icon">\u{1F4C1}</span><span class="meta-label">Group</span><span class="meta-val" style="color:#9c27b0">' + esc(group) + '</span></div>');

    // Updates
    const updatesHtml: string[] = [];
    if (task.updates && task.updates.length > 0) {
      task.updates.forEach((u, i) => {
        const date = new Date(u.created_at).toLocaleDateString();
        const author = u.creator?.name || 'Unknown';
        const body = esc(u.text_body || '').replace(/\n/g, '<br>');
        const assetsArr: string[] = [];
        if (u.assets && u.assets.length > 0) {
          u.assets.forEach(a => {
            const ext = (a.file_extension || '').toLowerCase();
            const aUrl = a.public_url || a.url;
            if (['png','jpg','jpeg','gif','webp','svg'].includes(ext)) {
              assetsArr.push('<img src="' + aUrl + '" alt="' + esc(a.name) + '" />');
            } else if (['mp4','webm','mov'].includes(ext)) {
              assetsArr.push('<video src="' + aUrl + '" controls></video>');
            } else {
              assetsArr.push('<a href="' + aUrl + '">\u{1F4CE} ' + esc(a.name) + '</a>');
            }
          });
        }
        // Replies thread
        let repliesHtml = '';
        if (u.replies && u.replies.length > 0) {
          const replyParts = u.replies.map(r => {
            const rDate = new Date(r.created_at).toLocaleDateString();
            const rAuthor = r.creator?.name || 'Unknown';
            const rPhoto = (r.creator as any)?.photo_thumb_small;
            const rBody = esc(r.text_body || '').replace(/\n/g, '<br>');
            let rHash = 0;
            for (let rc = 0; rc < rAuthor.length; rc++) rHash = rAuthor.charCodeAt(rc) + ((rHash << 5) - rHash);
            const rColor = colors[Math.abs(rHash) % colors.length];
            const rInitials = rAuthor.split(' ').map((w: string) => w[0]).join('').substring(0, 2).toUpperCase();
            const rAvatarHtml = rPhoto
              ? '<img class="avatar-sm" src="' + rPhoto + '" />'
              : '<span class="avatar-sm" style="background:' + rColor + '">' + rInitials + '</span>';
            return '<div class="reply">' +
              '<div class="reply-hdr">' + rAvatarHtml + '<span class="author">' + esc(rAuthor) + '</span><span class="date">' + rDate + '</span></div>' +
              '<div class="reply-body">' + rBody + '</div>' +
              '</div>';
          });
          repliesHtml = '<div class="replies">' + replyParts.join('') + '</div>';
        }

        // Avatar: use photo or colored initials
        const colors = ['#0073ea','#00c875','#e2445c','#fdab3d','#a25ddc','#579bfc','#ff158a','#ff5ac4','#cab641','#00d2d2'];
        let hash = 0;
        for (let c = 0; c < author.length; c++) hash = author.charCodeAt(c) + ((hash << 5) - hash);
        const avatarColor = colors[Math.abs(hash) % colors.length];
        const initials = author.split(' ').map((w: string) => w[0]).join('').substring(0, 2).toUpperCase();
        const photoUrl = u.creator?.photo_thumb_small;
        const avatarHtml = photoUrl
          ? '<img class="avatar" src="' + photoUrl + '" />'
          : '<span class="avatar" style="background:' + avatarColor + '">' + initials + '</span>';

        updatesHtml.push(
          '<div class="update">' +
          '<div class="update-hdr" onclick="tog(' + i + ')">' +
          '<span class="arr" id="a' + i + '">\u25B6</span>' +
          avatarHtml +
          '<span class="author">' + esc(author) + '</span>' +
          (u.replies && u.replies.length ? '<span class="reply-badge">' + u.replies.length + ' replies</span>' : '') +
          '<span class="date">' + date + '</span>' +
          '</div>' +
          '<div class="update-body" id="u' + i + '">' +
          body +
          (assetsArr.length ? '<div class="assets">' + assetsArr.join('') + '</div>' : '') +
          repliesHtml +
          '</div></div>'
        );
      });
    }

    // Sub-items
    const subHtml: string[] = [];
    if (task.subitems && task.subitems.length > 0) {
      task.subitems.forEach(sub => {
        const subStatus = sub.column_values.find(c => c.id.includes('status') || (c.column?.title || '').toLowerCase() === 'status')?.text || '';
        const isDone = subStatus.toLowerCase().includes('done');
        const isProgress = subStatus.toLowerCase().includes('progress');
        const icon = isDone ? '\u2705' : isProgress ? '\u{1F535}' : '\u2B55';
        const color = isDone ? '#4caf50' : isProgress ? '#2196f3' : '#ff9800';
        subHtml.push(
          '<div class="sub-row">' +
          '<span>' + icon + '</span>' +
          '<span class="sub-name">' + esc(sub.name) + '</span>' +
          '<span class="sub-status" style="background:' + color + ';color:#fff">' + esc(subStatus) + '</span>' +
          '</div>'
        );
      });
    }

    return [
      '<!DOCTYPE html><html><head><style>',
      ':root { --monday-bg: #292f4c; --monday-card: #30324e; --monday-border: rgba(255,255,255,0.08); --monday-blue: #0073ea; --monday-green: #00c875; --monday-red: #e2445c; --monday-orange: #fdab3d; --monday-purple: #a25ddc; --monday-text: #d5d8df; --monday-text2: #9699a6; }',
      '* { box-sizing: border-box; margin: 0; padding: 0; }',
      'body { font-family: "Figtree", "Poppins", var(--vscode-font-family), sans-serif; color: var(--monday-text); padding: 14px; font-size: 13px; line-height: 1.5; overflow-x: hidden; }',
      '',
      '.task-title { font-size: 16px; font-weight: 600; padding: 0 0 12px; margin-bottom: 12px; border-bottom: 1px solid var(--monday-border); color: #fff; }',
      '.task-id { opacity: 0.3; font-size: 11px; font-weight: 400; }',
      '',
      '.meta { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 16px; }',
      '.badge { display: inline-flex; align-items: center; gap: 5px; padding: 4px 12px; border-radius: 16px; font-size: 12px; font-weight: 500; }',
      '.badge .dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }',
      '',
      '.section { font-size: 13px; font-weight: 600; color: #fff; margin: 20px 0 10px; padding-bottom: 8px; border-bottom: 1px solid var(--monday-border); }',
      '.section .count { font-weight: 400; color: var(--monday-text2); }',
      '',
      '.update { margin: 0 0 6px; background: var(--monday-card); border: 1px solid var(--monday-border); border-radius: 8px; overflow: hidden; }',
      '.update-hdr { display: flex; align-items: center; gap: 10px; padding: 10px 12px; cursor: pointer; transition: background 0.15s; }',
      '.update-hdr:hover { background: rgba(255,255,255,0.04); }',
      '.avatar { width: 28px; height: 28px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 700; color: #fff; flex-shrink: 0; object-fit: cover; }',
      'img.avatar { width: 28px; height: 28px; border-radius: 50%; object-fit: cover; flex-shrink: 0; }',
      '.avatar-sm { width: 22px; height: 22px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 9px; font-weight: 700; color: #fff; flex-shrink: 0; object-fit: cover; }',
      'img.avatar-sm { width: 22px; height: 22px; border-radius: 50%; object-fit: cover; flex-shrink: 0; }',
      '.arr { font-size: 9px; transition: transform 0.2s; opacity: 0.35; color: var(--monday-text2); }',
      '.arr.open { transform: rotate(90deg); opacity: 0.7; }',
      '.author { font-weight: 600; font-size: 13px; color: #fff; }',
      '.date { margin-left: auto; color: var(--monday-text2); font-size: 11px; }',
      '.reply-badge { font-size: 11px; padding: 2px 8px; border-radius: 12px; background: rgba(0,115,234,0.15); color: var(--monday-blue); font-weight: 500; }',
      '.update-body { display: none; padding: 2px 14px 14px 50px; font-size: 13px; line-height: 1.7; word-wrap: break-word; overflow-wrap: break-word; color: var(--monday-text); }',
      '.update-body img { max-width: 100%; border-radius: 8px; margin: 8px 0; }',
      '.update-body video { max-width: 100%; border-radius: 8px; margin: 8px 0; }',
      '.assets { margin-top: 10px; }',
      '',
      '.replies { margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--monday-border); }',
      '.reply { margin: 8px 0; padding: 10px 12px; background: rgba(255,255,255,0.02); border-radius: 8px; border-left: 3px solid var(--monday-blue); }',
      '.reply-hdr { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }',
      '.reply .author { font-size: 12px; }',
      '.reply .date { font-size: 10px; }',
      '.reply-body { font-size: 13px; line-height: 1.65; word-wrap: break-word; color: var(--monday-text); padding-left: 30px; }',
      '',
      '.sub-row { display: flex; align-items: center; gap: 8px; padding: 7px 10px; border-radius: 6px; font-size: 13px; transition: background 0.1s; }',
      '.sub-row:hover { background: rgba(255,255,255,0.03); }',
      '.sub-name { flex: 1; }',
      '.sub-status { font-size: 11px; padding: 2px 10px; border-radius: 12px; font-weight: 500; white-space: nowrap; }',
      '',
      'a { color: var(--monday-blue); text-decoration: none; }',
      'a:hover { text-decoration: underline; }',
      '.open-btn { display: block; text-align: center; margin: 18px 0 6px; padding: 10px; background: var(--monday-blue); color: #fff; border-radius: 8px; text-decoration: none; font-size: 13px; font-weight: 600; transition: opacity 0.15s; }',
      '.open-btn:hover { opacity: 0.85; text-decoration: none; }',
      '</style></head><body>',
      '<div class="task-title">' + esc(task.name) + ' <span class="task-id">#' + task.id + '</span></div>',
      '<div class="meta">' +
        (status ? '<span class="badge" style="background:' + statusColor + ';color:#fff">' + esc(status) + '</span>' : '') +
        (priority ? '<span class="badge" style="background:' + prioColor + ';color:#fff">' + esc(priority) + '</span>' : '') +
        (person ? '<span class="badge">\u{1F464} ' + esc(person) + '</span>' : '') +
        (group ? '<span class="badge" style="color:var(--accent2)">\u{1F4C1} ' + esc(group) + '</span>' : '') +
      '</div>',
      updatesHtml.length ? '<div class="section">\u{1F4AC} Updates <span class="count">(' + task.updates.length + ')</span></div>' + updatesHtml.join('\n') : '',
      subHtml.length ? '<div class="section">\u{1F4CB} Sub-Items <span class="count">(' + task.subitems.length + ')</span></div>' + subHtml.join('\n') : '',
      '<a class="open-btn" href="' + this._url + '">Open in Monday.com \u2197</a>',
      '<script>function tog(i){var e=document.getElementById("u"+i),a=document.getElementById("a"+i);if(e.style.display==="block"){e.style.display="none";a.classList.remove("open")}else{e.style.display="block";a.classList.add("open")}}</script>',
      '</body></html>'
    ].join('\n');
  }
}

class MondaySidebarController {
  private treeProvider: MondayTaskTreeProvider;
  private webviewProvider: MondayWebviewProvider | null = null;
  private lastBranch: string = '';
  private lastTaskId: string = '';

  constructor(treeProvider: MondayTaskTreeProvider) {
    this.treeProvider = treeProvider;
  }

  setWebviewProvider(provider: MondayWebviewProvider) {
    this.webviewProvider = provider;
  }

  async update(): Promise<void> {
    const branch = await getCurrentBranchName();
    if (!branch) {
      this.treeProvider.setNoTask();
      clearContextFiles();
      this.lastBranch = '';
      this.lastTaskId = '';
      return;
    }

    const taskId = resolveTaskIdForBranch(branch);
    if (!taskId) {
      this.treeProvider.setNoTask();
      clearContextFiles();
      this.lastBranch = branch;
      this.lastTaskId = '';
      return;
    }

    // Only re-fetch if branch or task ID changed
    if (branch === this.lastBranch && taskId === this.lastTaskId) {
      return;
    }

    this.lastBranch = branch;
    this.lastTaskId = taskId;

    const boardId = getMondayBoardId();
    const url = getMondayTaskUrl(boardId, taskId);

    const task = await fetchDetailedMondayTask(taskId);
    if (task) {
      this.treeProvider.setTask(task, url);
      this.webviewProvider?.setTask(task, url);
      await writeContextFiles(task, url);
    } else {
      this.treeProvider.setNoTask();
      this.webviewProvider?.setNoTask();
      clearContextFiles();
    }
  }

  async forceRefresh(): Promise<void> {
    // Clear cache to force re-fetch
    this.lastBranch = '';
    this.lastTaskId = '';
    await this.update();
  }
}

// ========== Original Monday.com Functions ==========

async function fetchCurrentMondayUser(token: string): Promise<{ id: number; name: string } | null> {
  try {
    const response = await axios.post(MONDAY_API_URL, {
      query: '{ me { id name } }',
    }, {
      headers: {
        'Authorization': token,
        'Content-Type': 'application/json',
      },
    });
    const me = response.data?.data?.me;
    return me ? { id: me.id, name: me.name } : null;
  } catch (error) {
    console.error('Failed to fetch Monday user:', error);
    return null;
  }
}

async function fetchUserTasks(token: string, boardId: string): Promise<MondayTask[]> {
  try {
    // Get current user name to prioritize their tasks
    const currentUser = await fetchCurrentMondayUser(token);
    const currentUserName = currentUser?.name || '';

    // Fetch ALL items from the board (no person filter)
    const query = `
      query {
        boards(ids: [${boardId}]) {
          items_page(limit: 200) {
            items {
              id
              name
              group {
                id
                title
              }
              column_values(ids: ["person", "status9", "dup__of_priority_mkkassyk"]) {
                id
                text
              }
            }
          }
        }
      }
    `;

    const response = await axios.post(MONDAY_API_URL, { query }, {
      headers: {
        'Authorization': token,
        'Content-Type': 'application/json',
      },
    });

    const boards = response.data?.data?.boards;
    if (!boards || boards.length === 0) return [];

    const items = boards[0].items_page?.items || [];

    // Define group priority order (lower = higher priority)
    const groupPriority: Record<string, number> = {
      'in progress': 1,
      'code review': 2,
      'changes requires/reopen': 3,
      'deployed to dev': 4,
      'in testing (non production) stephanie': 5,
      'ready to be tackled': 6,
      'engineering backlog': 7,
      'apis backlog': 8,
      'inbox': 9,
      'bugs': 10,
    };

    // Define closed/done group patterns to exclude
    const doneGroupPatterns = ['done', 'nice to have', 'brainstorm', 'on hold',
      'missing info', 'dev reference', 'feature upgrade - backlog',
      'feature upgrade - to plan', 'product below', 'next phase'];

    // Map items
    const mapped = items
      .filter((item: any) => {
        const groupTitle = (item.group?.title || '').toLowerCase();
        return !doneGroupPatterns.some(p => groupTitle.includes(p));
      })
      .map((item: any) => {
        const groupTitle = item.group?.title || 'Unknown';
        const person = item.column_values?.find((c: any) => c.id === 'person')?.text || '';
        const status = item.column_values?.find((c: any) => c.id === 'status9')?.text || '';
        const priority = item.column_values?.find((c: any) => c.id === 'dup__of_priority_mkkassyk')?.text || '';
        const isCurrentUser = currentUserName && person.toLowerCase().includes(currentUserName.toLowerCase());
        const gPriority = groupPriority[groupTitle.toLowerCase()] || 99;
        return {
          id: item.id,
          name: item.name,
          boardId,
          group: groupTitle,
          person,
          status,
          priority,
          isCurrentUser,
          gPriority,
        };
      });

    // Sort: current user's tasks first, then by group priority
    mapped.sort((a: any, b: any) => {
      if (a.isCurrentUser && !b.isCurrentUser) return -1;
      if (!a.isCurrentUser && b.isCurrentUser) return 1;
      if (a.gPriority !== b.gPriority) return a.gPriority - b.gPriority;
      return 0;
    });

    return mapped;
  } catch (error: any) {
    console.error('Failed to fetch Monday tasks:', error);
    vscode.window.showErrorMessage(`Monday.com API error: ${error.message || 'Unknown error'}`);
    return [];
  }
}

function generatePrepareCommitMsgHook(boardId: string): string {
  return `#!/bin/sh
# Auto-generated by Toggl Track Auto - Monday.com integration
# Dynamically links commits to Monday task based on current branch

COMMIT_MSG_FILE=$1
COMMIT_SOURCE=$2

# Skip merge commits and squash commits
if [ "$COMMIT_SOURCE" = "merge" ] || [ "$COMMIT_SOURCE" = "squash" ]; then
  exit 0
fi

# Get current branch name
BRANCH=\$(git symbolic-ref --short HEAD 2>/dev/null)
if [ -z "\$BRANCH" ]; then
  exit 0
fi

# Extract Monday task ID from branch name (e.g., feat/12345678-task-name)
TASK_ID=\$(echo "\$BRANCH" | grep -oE '[0-9]{8,}' | head -1)

# Fallback: check .vscode/monday-tasks.json mapping
if [ -z "\$TASK_ID" ] && [ -f ".vscode/monday-tasks.json" ]; then
  TASK_ID=\$(python3 -c "import json; d=json.load(open('.vscode/monday-tasks.json')); print(d.get('\$BRANCH',{}).get('taskId',''))" 2>/dev/null)
fi

if [ -z "\$TASK_ID" ]; then
  exit 0
fi

MONDAY_URL="https://pivot584586.monday.com/boards/${boardId}/pulses/\$TASK_ID"

# Check if a Monday link is already in the message
if grep -q "Monday task:" "\$COMMIT_MSG_FILE" 2>/dev/null; then
  exit 0
fi

# Append the Monday task link
echo "" >> "\$COMMIT_MSG_FILE"
echo "Monday task: \$MONDAY_URL" >> "\$COMMIT_MSG_FILE"
`;
}

function generatePostCommitHook(boardId: string): string {
  const token = getMondayToken();
  // Use heredoc for Python to avoid shell escaping issues with \n in strings
  return `#!/bin/sh
# Auto-generated by Toggl Track Auto - Monday.com integration
# Posts commit updates to Monday.com task

python3 << 'TOGGL_PYEOF'
import json, subprocess, urllib.request, re, os

branch = subprocess.run(['git', 'symbolic-ref', '--short', 'HEAD'], capture_output=True, text=True).stdout.strip()
if not branch:
    exit(0)

m = re.search(r'(\\d{8,})', branch)
if not m:
    exit(0)
task_id = m.group(1)

token = os.environ.get('MONDAY_TOKEN', '${token}')
if not token:
    exit(0)

commit_msg = subprocess.run(['git', 'log', '-1', '--pretty=format:%s%n%n%b'], capture_output=True, text=True).stdout.strip()
commit_hash = subprocess.run(['git', 'log', '-1', '--pretty=format:%h'], capture_output=True, text=True).stdout.strip()
commit_author = subprocess.run(['git', 'log', '-1', '--pretty=format:%an'], capture_output=True, text=True).stdout.strip()

lines = [l for l in commit_msg.split('\\n') if not l.startswith('Monday task:')]
clean_msg = '\\n'.join(lines).strip()

body = 'Commit ' + commit_hash + ' by ' + commit_author + ':\\n\\n' + clean_msg
query = 'mutation { create_update(item_id: ' + task_id + ', body: ' + json.dumps(body) + ') { id } }'
payload = json.dumps({'query': query}).encode()

req = urllib.request.Request('https://api.monday.com/v2', data=payload, headers={
    'Authorization': token,
    'Content-Type': 'application/json',
})
try:
    urllib.request.urlopen(req, timeout=10)
except:
    pass
TOGGL_PYEOF
`;
}

async function installGitHooks(boardId: string): Promise<boolean> {
  const root = getWorkspaceRoot();
  if (!root) return false;

  const hooksDir = path.join(root, '.git', 'hooks');

  try {
    // Ensure hooks directory exists
    if (!fs.existsSync(hooksDir)) {
      fs.mkdirSync(hooksDir, { recursive: true });
    }

    // Install prepare-commit-msg hook
    const prepareHookPath = path.join(hooksDir, 'prepare-commit-msg');
    if (fs.existsSync(prepareHookPath)) {
      const existing = fs.readFileSync(prepareHookPath, 'utf-8');
      if (!existing.includes('Toggl Track Auto - Monday.com integration')) {
        const backupPath = prepareHookPath + '.backup';
        fs.writeFileSync(backupPath, existing);
      }
    }
    fs.writeFileSync(prepareHookPath, generatePrepareCommitMsgHook(boardId), { mode: 0o755 });

    // Install post-commit hook
    const postHookPath = path.join(hooksDir, 'post-commit');
    if (fs.existsSync(postHookPath)) {
      const existing = fs.readFileSync(postHookPath, 'utf-8');
      if (!existing.includes('Toggl Track Auto - Monday.com integration')) {
        const backupPath = postHookPath + '.backup';
        fs.writeFileSync(backupPath, existing);
      }
    }
    fs.writeFileSync(postHookPath, generatePostCommitHook(boardId), { mode: 0o755 });

    return true;
  } catch (error) {
    console.error('Failed to install git hooks:', error);
    return false;
  }
}

// Keep backward compat alias
async function installPrepareCommitMsgHook(boardId: string): Promise<boolean> {
  return installGitHooks(boardId);
}

async function createBranchFromTask(): Promise<void> {
  const root = getWorkspaceRoot();
  if (!root) {
    vscode.window.showErrorMessage('No workspace folder open.');
    return;
  }

  const token = getMondayToken();
  if (!token) {
    vscode.window.showErrorMessage('Monday.com token not configured. Set MONDAY_TOKEN env var or togglTrackAuto.mondayApiToken setting.');
    return;
  }

  const boardId = getMondayBoardId();

  // Fetch tasks with progress
  const tasks = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Fetching Monday.com tasks...' },
    () => fetchUserTasks(token, boardId)
  );

  if (tasks.length === 0) {
    vscode.window.showInformationMessage('No Monday.com tasks found on the board.');
    return;
  }

  // Show QuickPick with group separators, status, and person info
  let lastGroup = '';
  const items: (vscode.QuickPickItem & { task?: any })[] = [];
  for (const task of tasks) {
    const group = (task as any).group || 'Unknown';
    const isCurrentUser = (task as any).isCurrentUser;
    const sectionLabel = isCurrentUser && lastGroup !== `⭐ Your Tasks — ${group}` 
      ? `⭐ Your Tasks — ${group}` 
      : !isCurrentUser && (lastGroup.startsWith('⭐') || lastGroup !== group) 
        ? group 
        : '';
    
    if (sectionLabel && sectionLabel !== lastGroup) {
      items.push({ label: sectionLabel, kind: vscode.QuickPickItemKind.Separator } as any);
      lastGroup = sectionLabel;
    }
    const person = (task as any).person || '';
    const status = (task as any).status || '';
    const priority = (task as any).priority || '';
    const priorityTag = priority ? priority.split(' - ')[0] : '';
    const descParts = [`#${task.id}`];
    if (status) descParts.push(status);
    if (priorityTag) descParts.push(priorityTag);

    items.push({
      label: `${isCurrentUser ? '$(star-full) ' : ''}${task.name}`,
      description: descParts.join('  ·  '),
      detail: person ? `👤 ${person}` : undefined,
      task,
    });
  }

  const selected = await vscode.window.showQuickPick(items, {
    placeHolder: 'Select a Monday.com task to create a branch for',
    matchOnDescription: true,
    matchOnDetail: true,
  });

  if (!selected) return;

  const task = selected.task;
  const suggestedBranch = `feat/${task.id}-${slugify(task.name)}`;

  // Let user edit the branch name
  const branchName = await vscode.window.showInputBox({
    prompt: 'Branch name (edit if needed)',
    value: suggestedBranch,
    validateInput: (value) => {
      if (!value || value.trim().length === 0) return 'Branch name cannot be empty';
      if (/\s/.test(value)) return 'Branch name cannot contain spaces';
      if (/[~^:?*\[\\]/.test(value)) return 'Branch name contains invalid characters';
      return null;
    },
  });

  if (!branchName) return;

  // Create and checkout the branch
  try {
    await execAsync(`git checkout -b "${branchName}"`, { cwd: root });
  } catch (error: any) {
    vscode.window.showErrorMessage(`Failed to create branch: ${error.message}`);
    return;
  }

  // Store the mapping
  const mappings = readBranchTaskMappings();
  mappings[branchName] = {
    taskId: task.id,
    taskName: task.name,
    boardId: task.boardId,
    url: getMondayTaskUrl(task.boardId, task.id),
  };
  writeBranchTaskMappings(mappings);

  // Install prepare-commit-msg hook
  const hookInstalled = await installPrepareCommitMsgHook(task.boardId);

  const actions = ['Open in Monday.com'];
  const result = await vscode.window.showInformationMessage(
    `✅ Branch "${branchName}" created and checked out.\n${hookInstalled ? 'Commit hook installed.' : '⚠️ Could not install commit hook.'}`,
    ...actions
  );

  if (result === 'Open in Monday.com') {
    vscode.env.openExternal(vscode.Uri.parse(getMondayTaskUrl(task.boardId, task.id)));
  }
}

async function copyMondayTaskLink(): Promise<void> {
  const root = getWorkspaceRoot();
  if (!root) {
    vscode.window.showErrorMessage('No workspace folder open.');
    return;
  }

  try {
    const { stdout } = await execAsync('git rev-parse --abbrev-ref HEAD', { cwd: root });
    const branch = stdout.trim();

    const mappings = readBranchTaskMappings();
    const mapping = mappings[branch];

    if (!mapping) {
      // Try to extract Monday ID from branch name as fallback
      const match = branch.match(/(\d{6,})/);
      if (match) {
        const boardId = getMondayBoardId();
        const url = getMondayTaskUrl(boardId, match[1]);
        await vscode.env.clipboard.writeText(url);
        vscode.window.showInformationMessage(`📋 Monday task link copied (from branch ID): ${url}`);
        return;
      }
      vscode.window.showWarningMessage('No Monday.com task associated with this branch.');
      return;
    }

    await vscode.env.clipboard.writeText(mapping.url);
    vscode.window.showInformationMessage(`📋 Monday task link copied: ${mapping.url}`);
  } catch (error) {
    vscode.window.showErrorMessage('Failed to get current branch.');
  }
}

// Monitor for branch pushes and suggest including Monday link
async function checkBranchForMondayLink(): Promise<void> {
  const root = getWorkspaceRoot();
  if (!root) return;

  try {
    const { stdout } = await execAsync('git rev-parse --abbrev-ref HEAD', { cwd: root });
    const branch = stdout.trim();
    const mappings = readBranchTaskMappings();
    const mapping = mappings[branch];

    if (mapping) {
      // Update the prepare-commit-msg hook for the current branch's task
      await installPrepareCommitMsgHook(mapping.boardId);
    }
  } catch {
    // ignore
  }
}

// ========== End Monday.com Task Integration ==========

async function runSetupWizard(): Promise<boolean> {
  const config = vscode.workspace.getConfiguration('togglTrackAuto');
  
  // Check if already configured
  if (config.get<string>('apiToken') && config.get<number>('workspaceId')) {
    return true;
  }

  const start = await vscode.window.showInformationMessage(
    '🚀 Welcome to Toggl Track Auto! Let\'s set it up.',
    'Start Setup',
    'Later'
  );

  if (start !== 'Start Setup') {
    return false;
  }

  // Step 1: API Token
  const tokenInfo = await vscode.window.showInformationMessage(
    '📋 Step 1: Get your Toggl API token from https://track.toggl.com/profile (scroll to bottom)',
    'Open Toggl Profile',
    'I have it'
  );

  if (tokenInfo === 'Open Toggl Profile') {
    vscode.env.openExternal(vscode.Uri.parse('https://track.toggl.com/profile'));
  }

  const apiToken = await vscode.window.showInputBox({
    prompt: 'Enter your Toggl API token',
    placeHolder: 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    password: true,
    ignoreFocusOut: true,
  });

  if (!apiToken) {
    vscode.window.showWarningMessage('Setup cancelled. Run "Toggl: Setup" to try again.');
    return false;
  }

  // Validate token
  try {
    const response = await axios.get('https://api.track.toggl.com/api/v9/me', {
      auth: { username: apiToken, password: 'api_token' },
    });
    
    const user = response.data;
    vscode.window.showInformationMessage(`✅ Connected as ${user.fullname || user.email}`);
    
    // Save token
    await config.update('apiToken', apiToken, vscode.ConfigurationTarget.Global);
    
    // Get workspace ID from user's default
    const workspaceId = user.default_workspace_id;
    await config.update('workspaceId', workspaceId, vscode.ConfigurationTarget.Global);
    
  } catch (error) {
    vscode.window.showErrorMessage('❌ Invalid API token. Please check and try again.');
    return false;
  }

  // Monday.com integration - users should set MONDAY_TOKEN env var or configure in settings
  const mondayToken = getMondayToken();
  if (mondayToken) {
    await config.update('mondayApiToken', mondayToken, vscode.ConfigurationTarget.Global);
    vscode.window.showInformationMessage('✅ Monday.com integration configured from environment!');
  } else {
    vscode.window.showWarningMessage('⚠️ Set MONDAY_TOKEN env var for Monday.com integration');
  }

  vscode.window.showInformationMessage(
    '🎉 Setup complete! Toggl will now auto-track based on your git branch.'
  );

  return true;
}

interface TogglTimeEntry {
  id: number;
  description: string;
  start: string;
  workspace_id: number;
  project_id?: number;
}

interface MondayItem {
  id: string;
  name: string;
}

class TogglTracker {
  private statusBarItem: vscode.StatusBarItem;
  private newBranchStatusBarItem: vscode.StatusBarItem;
  private breakStatusBarItem: vscode.StatusBarItem;
  private currentBranch: string = '';
  private currentEntryId: number | null = null;
  private lastActivity: number = Date.now();
  private checkInterval: NodeJS.Timeout | null = null;
  private idleCheckInterval: NodeJS.Timeout | null = null;
  private isTracking: boolean = false;
  private taskCache: Map<string, string> = new Map();
  // Track last stopped entry for resume feature
  private lastStoppedDescription: string = '';
  private lastStoppedTime: number = 0;
  private lastStoppedEntryId: number | null = null;
  private currentDescription: string = '';
  // Break tracking
  private isOnBreak: boolean = false;
  private preBreakEntryId: number | null = null;
  private preBreakDescription: string = '';
  private preBreakBranch: string = '';
  // Org filtering
  private isOrgAllowed: boolean = false;
  private lastCheckedOrgFolder: string = '';
  // Monday sidebar controller (set externally)
  public mondaySidebarController: MondaySidebarController | null = null;

  constructor() {
    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      100
    );
    this.statusBarItem.command = 'toggl-track-auto.status';
    
    // Show version in tooltip
    const extension = vscode.extensions.getExtension('pivot.toggl-track-auto');
    const version = extension?.packageJSON?.version || 'unknown';
    this.statusBarItem.tooltip = `Toggl Track Auto v${version}\nClick for status`;
    
    this.statusBarItem.show();
    this.updateStatusBar('$(clock) Toggl: Initializing...');
    
    // New branch button (between indicator and break)
    this.newBranchStatusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      99.5
    );
    this.newBranchStatusBarItem.command = 'toggl-track-auto.createBranchFromTask';
    this.newBranchStatusBarItem.text = '$(add)';
    this.newBranchStatusBarItem.tooltip = 'Create a new branch from a Monday.com task';
    this.newBranchStatusBarItem.show();
    
    // Break button
    this.breakStatusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      99
    );
    this.breakStatusBarItem.command = 'toggl-track-auto.toggleBreak';
    this.updateBreakButton();
    this.breakStatusBarItem.show();
  }
  
  private updateBreakButton() {
    if (this.isOnBreak) {
      this.breakStatusBarItem.text = '$(debug-stop) End Break';
      this.breakStatusBarItem.tooltip = 'Click to end break and resume work';
      this.breakStatusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    } else {
      this.breakStatusBarItem.text = '$(coffee) Break';
      this.breakStatusBarItem.tooltip = 'Click to start a break';
      this.breakStatusBarItem.backgroundColor = undefined;
    }
  }

  private getConfig() {
    return vscode.workspace.getConfiguration('togglTrackAuto');
  }

  private updateStatusBar(text: string) {
    this.statusBarItem.text = text;
  }

  /**
   * Extract the GitHub org/user from the git remote URL of the current workspace.
   */
  private async getGitRemoteOrg(): Promise<string | null> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      return null;
    }

    try {
      const { stdout } = await execAsync('git remote get-url origin', {
        cwd: workspaceFolders[0].uri.fsPath,
      });
      const url = stdout.trim();

      // SSH format: git@github.com:org/repo.git
      const sshMatch = url.match(/git@github\.com:([^/]+)\//);
      if (sshMatch) return sshMatch[1].toLowerCase();

      // HTTPS format: https://github.com/org/repo.git
      const httpsMatch = url.match(/github\.com\/([^/]+)\//);
      if (httpsMatch) return httpsMatch[1].toLowerCase();

      return null;
    } catch {
      return null;
    }
  }

  /**
   * Check if the current repo belongs to one of the allowed GitHub organizations.
   */
  async checkOrgAllowed(): Promise<boolean> {
    const config = this.getConfig();
    const allowedOrgs = config.get<string[]>('allowedOrgs') || [];

    // Empty list = no filtering, allow all
    if (allowedOrgs.length === 0) {
      this.isOrgAllowed = true;
      return true;
    }

    // Cache per workspace folder path
    const workspaceFolders = vscode.workspace.workspaceFolders;
    const currentFolder = workspaceFolders?.[0]?.uri.fsPath || '';
    
    if (currentFolder && currentFolder === this.lastCheckedOrgFolder) {
      return this.isOrgAllowed;
    }

    this.lastCheckedOrgFolder = currentFolder;
    const org = await this.getGitRemoteOrg();

    if (!org) {
      this.isOrgAllowed = false;
      return false;
    }

    this.isOrgAllowed = allowedOrgs.some(
      (allowed) => allowed.toLowerCase() === org
    );

    return this.isOrgAllowed;
  }

  async start() {
    const config = this.getConfig();
    if (!config.get<boolean>('enabled')) {
      this.updateStatusBar('$(clock) Toggl: Disabled');
      return;
    }

    const apiToken = config.get<string>('apiToken');
    if (!apiToken) {
      this.updateStatusBar('$(warning) Toggl: No API token');
      vscode.window.showWarningMessage(
        'Toggl Track Auto: Please set your API token in settings'
      );
      return;
    }

    // Check if the current repo belongs to an allowed org
    const orgAllowed = await this.checkOrgAllowed();
    if (!orgAllowed) {
      const org = await this.getGitRemoteOrg();
      console.log(`Toggl: Repo org "${org || 'unknown'}" not in allowed list, staying silent`);
      this.statusBarItem.hide();
      this.newBranchStatusBarItem.hide();
      this.breakStatusBarItem.hide();
      vscode.commands.executeCommand('setContext', 'togglMondayTask.visible', false);
      return;
    }

    this.statusBarItem.show();
    this.newBranchStatusBarItem.show();
    this.breakStatusBarItem.show();
    vscode.commands.executeCommand('setContext', 'togglMondayTask.visible', true);
    this.isTracking = true;
    await this.checkBranch();

    // Check branch every 10 seconds
    this.checkInterval = setInterval(() => this.checkBranch(), 15000);

    // Check for idle every 30 seconds
    this.idleCheckInterval = setInterval(() => this.checkIdle(), 30000);

    // Track activity
    vscode.workspace.onDidChangeTextDocument(() => this.onActivity());
    vscode.window.onDidChangeActiveTextEditor(() => this.onActivity());
    vscode.window.onDidChangeTextEditorSelection(() => this.onActivity());

    // Re-check org when workspace folders change
    vscode.workspace.onDidChangeWorkspaceFolders(async () => {
      this.lastCheckedOrgFolder = ''; // Reset cache
      const allowed = await this.checkOrgAllowed();
      if (!allowed) {
        console.log('Toggl: Workspace changed to non-allowed org, stopping');
        await this.stop();
        this.statusBarItem.hide();
        this.newBranchStatusBarItem.hide();
        this.breakStatusBarItem.hide();
        vscode.commands.executeCommand('setContext', 'togglMondayTask.visible', false);
      } else {
        this.statusBarItem.show();
        this.newBranchStatusBarItem.show();
        this.breakStatusBarItem.show();
        vscode.commands.executeCommand('setContext', 'togglMondayTask.visible', true);
        if (!this.isTracking) {
          await this.start();
        }
      }
    });

    // Handle window focus - focused window takes over Toggl
    vscode.window.onDidChangeWindowState(async (state) => {
      if (state.focused && this.isTracking) {
        console.log('Window focused - taking over Toggl tracking (v0.20.0)');
        // Check what Toggl is currently tracking
        const currentTogglEntry = await this.getCurrentTogglEntry();
        const branch = await this.getCurrentBranch();
        
        if (branch) {
          // Get what this branch SHOULD be tracking
          const ticketId = this.extractTicketId(branch);
          let expectedDesc = branch;
          if (ticketId) {
            const taskName = await this.getMondayTaskName(ticketId);
            if (taskName) expectedDesc = taskName;
          }
          
          // If Toggl is tracking something different, switch to this branch
          if (!currentTogglEntry || currentTogglEntry.description !== expectedDesc) {
            console.log(`Switching from "${currentTogglEntry?.description}" to "${expectedDesc}"`);
            this.currentBranch = ''; // Force restart
            await this.checkBranch();
          }
        }

        // Also update sidebar on focus
        if (this.mondaySidebarController) {
          this.mondaySidebarController.update();
        }
      }
    });
  }

  async stop() {
    this.isTracking = false;
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
    if (this.idleCheckInterval) {
      clearInterval(this.idleCheckInterval);
      this.idleCheckInterval = null;
    }
    await this.stopCurrentEntry();
    this.updateStatusBar('$(clock) Toggl: Stopped');
  }

  private onActivity() {
    this.lastActivity = Date.now();
  }

  private async checkIdle() {
    const config = this.getConfig();
    const idleTimeout = config.get<number>('idleTimeoutMinutes') || 5;
    const idleMs = idleTimeout * 60 * 1000;

    if (Date.now() - this.lastActivity > idleMs && this.currentEntryId) {
      await this.stopCurrentEntry();
      this.updateStatusBar('$(clock) Toggl: Idle (paused)');
    }
  }

  private async getCurrentBranch(): Promise<string | null> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      return null;
    }

    try {
      const { stdout } = await execAsync('git rev-parse --abbrev-ref HEAD', {
        cwd: workspaceFolders[0].uri.fsPath,
      });
      return stdout.trim();
    } catch {
      return null;
    }
  }

  private extractTicketId(branch: string): string | null {
    return extractTaskIdFromBranch(branch);
  }

  private async getMondayTaskName(ticketId: string): Promise<string | null> {
    // Check cache first
    if (this.taskCache.has(ticketId)) {
      return this.taskCache.get(ticketId)!;
    }

    const config = this.getConfig();
    const mondayToken = config.get<string>('mondayApiToken') || getMondayToken();

    try {
      const query = `
        query {
          items(ids: [${ticketId}]) {
            id
            name
          }
        }
      `;

      const response = await axios.post(
        'https://api.monday.com/v2',
        { query },
        {
          headers: {
            Authorization: mondayToken,
            'Content-Type': 'application/json',
          },
        }
      );

      const items = response.data?.data?.items;
      if (items && items.length > 0) {
        const name = items[0].name;
        this.taskCache.set(ticketId, name);
        return name;
      }
    } catch (error) {
      console.error('Failed to fetch Monday.com task:', error);
    }

    return null;
  }

  // Find previous Toggl entry with same description
  private async getPreviousEntry(description: string): Promise<any | null> {
    const config = this.getConfig();
    const apiToken = config.get<string>('apiToken');
    
    if (!apiToken) return null;
    
    try {
      // Get recent time entries (last 7 days)
      const endDate = new Date();
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - 7);
      
      const response = await axios.get(
        `https://api.track.toggl.com/api/v9/me/time_entries`,
        {
          params: {
            start_date: startDate.toISOString(),
            end_date: endDate.toISOString(),
          },
          auth: { username: apiToken, password: 'api_token' },
        }
      );
      
      // Find most recent entry with matching description that has project or tags
      const entries = response.data || [];
      
      // Helper to check if descriptions match (exact or fuzzy)
      const descMatches = (entryDesc: string, targetDesc: string) => {
        if (!entryDesc || !targetDesc) return false;
        if (entryDesc === targetDesc) return true;
        // Fuzzy match on first 30 chars
        return entryDesc.startsWith(targetDesc.substring(0, 30)) ||
               targetDesc.startsWith(entryDesc.substring(0, 30));
      };
      
      // First priority: find entry with SAME description that HAS project or tags
      let matchingEntry = entries.find((e: any) => 
        e.duration >= 0 && 
        descMatches(e.description, description) &&
        (e.project_id || (e.tags && e.tags.length > 0))
      );
      
      // Fallback: any matching entry (even without project/tags)
      if (!matchingEntry) {
        matchingEntry = entries.find((e: any) => 
          e.duration >= 0 && descMatches(e.description, description)
        );
      }
      
      return matchingEntry || null;
    } catch (error) {
      console.error('Failed to fetch previous Toggl entries:', error);
    }
    
    return null;
  }

  private async getCurrentTogglEntry(): Promise<any | null> {
    const config = this.getConfig();
    const apiToken = config.get<string>('apiToken');
    
    if (!apiToken) return null;
    
    try {
      const response = await axios.get(
        'https://api.track.toggl.com/api/v9/me/time_entries/current',
        {
          auth: { username: apiToken, password: 'api_token' },
        }
      );
      return response.data;
    } catch (error) {
      return null;
    }
  }

  private async checkBranch() {
    if (!this.isTracking) return;

    const branch = await this.getCurrentBranch();
    if (!branch) {
      if (this.currentEntryId) {
        await this.stopCurrentEntry();
      }
      this.updateStatusBar('$(clock) Toggl: No git repo');
      return;
    }

    // Only call Toggl API when branch changes or no active entry (saves API quota)
    if (branch === this.currentBranch && this.currentEntryId) {
      return;
    }

    // Resume tracking if we were idle
    if (!this.currentEntryId && Date.now() - this.lastActivity < 30000) {
      this.currentBranch = ''; // Force restart
    }

    if (branch !== this.currentBranch) {
      // Sync with Toggl only on branch change
      const currentTogglEntry = await this.getCurrentTogglEntry();
      if (currentTogglEntry && currentTogglEntry.id) {
        this.currentEntryId = currentTogglEntry.id;
        this.currentDescription = currentTogglEntry.description || '';
      }

      this.currentBranch = branch;
      await this.stopCurrentEntry();
      await this.startNewEntry(branch);

      // Update Monday sidebar when branch changes
      if (this.mondaySidebarController) {
        this.mondaySidebarController.update();
      }
    }
  }

  private async stopCurrentEntry() {
    if (!this.currentEntryId) return;

    const config = this.getConfig();
    const apiToken = config.get<string>('apiToken');
    const workspaceId = config.get<number>('workspaceId');

    if (!apiToken || !workspaceId) return;

    try {
      await axios.patch(
        `https://api.track.toggl.com/api/v9/workspaces/${workspaceId}/time_entries/${this.currentEntryId}/stop`,
        {},
        {
          auth: { username: apiToken, password: 'api_token' },
        }
      );
    } catch (error) {
      console.error('Failed to stop Toggl entry:', error);
    }

    // Save info for resume feature
    this.lastStoppedEntryId = this.currentEntryId;
    this.lastStoppedDescription = this.currentDescription;
    this.lastStoppedTime = Date.now();
    
    this.currentEntryId = null;
    this.currentDescription = '';
  }

  private async startNewEntry(branch: string) {
    const config = this.getConfig();
    const apiToken = config.get<string>('apiToken');
    const workspaceId = config.get<number>('workspaceId');
    let projectId = config.get<number>('projectId');

    if (!apiToken || !workspaceId) return;

    const ticketId = this.extractTicketId(branch);
    let description = branch;
    let tags: string[] = [];

    if (ticketId) {
      const taskName = await this.getMondayTaskName(ticketId);
      
      if (taskName) {
        // If we found a task name, just use it (no ID needed)
        description = taskName;
      } else {
        // No task name found, use ID + branch
        description = `[${ticketId}] ${branch}`;
      }
    }
    
    // Look up previous Toggl entry with same description to copy project/tags
    const previousEntry = await this.getPreviousEntry(description);
    
    if (previousEntry) {
      // Reuse project and tags from previous entry
      if (previousEntry.project_id) {
        projectId = previousEntry.project_id;
      }
      if (previousEntry.tags && previousEntry.tags.length > 0) {
        tags = [...previousEntry.tags];
      }
      
      // Check if we should continue the previous entry (stopped within 10 min)
      const tenMinutesMs = 10 * 60 * 1000;
      const entryStopTime = new Date(previousEntry.stop).getTime();
      const timeSinceStop = Date.now() - entryStopTime;
      
      if (timeSinceStop < tenMinutesMs) {
        // Continue the previous entry by updating it to be running again
        console.log('Continuing previous Toggl entry');
        
        try {
          // Update the previous entry: set duration to -1 (running) and keep original start
          const response = await axios.put(
            `https://api.track.toggl.com/api/v9/workspaces/${workspaceId}/time_entries/${previousEntry.id}`,
            {
              duration: -1, // Make it running again
              stop: null,   // Remove stop time
            },
            {
              auth: { username: apiToken, password: 'api_token' },
            }
          );
          
          this.currentEntryId = response.data.id;
          this.currentDescription = description;
          this.updateStatusBar(`$(clock) Toggl: ${description.substring(0, 30)}... (continued)`);
          return;
        } catch (error) {
          console.error('Failed to continue entry, creating new one:', error);
        }
      }
    }

    try {
      const payload: any = {
        description,
        workspace_id: workspaceId,
        start: new Date().toISOString(),
        duration: -1, // Running timer
        created_with: 'toggl-track-vscode',
        billable: true,
      };

      if (projectId && projectId > 0) {
        payload.project_id = projectId;
      }

      if (tags.length > 0) {
        payload.tags = tags;
      }

      const response = await axios.post(
        `https://api.track.toggl.com/api/v9/workspaces/${workspaceId}/time_entries`,
        payload,
        {
          auth: { username: apiToken, password: 'api_token' },
        }
      );

      this.currentEntryId = response.data.id;
      this.currentDescription = description;
      this.updateStatusBar(`$(clock) Toggl: ${description.substring(0, 30)}...`);
      
    } catch (error) {
      console.error('Failed to start Toggl entry:', error);
      this.updateStatusBar('$(warning) Toggl: Error starting timer');
    }
  }

  async showStatus() {
    const config = this.getConfig();
    const apiToken = config.get<string>('apiToken');

    if (!apiToken) {
      vscode.window.showInformationMessage('Toggl: No API token configured');
      return;
    }

    try {
      const response = await axios.get(
        'https://api.track.toggl.com/api/v9/me/time_entries/current',
        {
          auth: { username: apiToken, password: 'api_token' },
        }
      );

      const entry = response.data;
      if (entry) {
        const start = new Date(entry.start);
        const duration = Math.floor((Date.now() - start.getTime()) / 1000 / 60);
        vscode.window.showInformationMessage(
          `Toggl: Currently tracking "${entry.description}" (${duration} min)`
        );
      } else {
        vscode.window.showInformationMessage('Toggl: No active time entry');
      }
    } catch (error: any) {
      const msg = error?.response?.data?.message || error?.message || 'Unknown error';
      vscode.window.showErrorMessage(`Toggl: Failed to fetch status - ${msg}`);
    }
  }

  async toggleBreak() {
    if (this.isOnBreak) {
      await this.endBreak();
    } else {
      await this.startBreak();
    }
  }

  async startBreak() {
    const config = this.getConfig();
    const apiToken = config.get<string>('apiToken');
    const workspaceId = config.get<number>('workspaceId');

    if (!apiToken || !workspaceId) {
      vscode.window.showErrorMessage('Toggl: Not configured');
      return;
    }

    // Ask what kind of break
    const breakType = await vscode.window.showQuickPick(
      ['☕ Coffee Break', '🍽️ Lunch Break', '🚶 Short Break'],
      { placeHolder: 'Select break type' }
    );

    if (!breakType) return;

    // Save current state before break
    this.preBreakEntryId = this.currentEntryId;
    this.preBreakDescription = this.currentDescription;
    this.preBreakBranch = this.currentBranch;

    // Stop current entry
    await this.stopCurrentEntry();

    // Start break entry
    const breakDescription = breakType.replace(/^[^\s]+\s/, ''); // Remove emoji
    try {
      const response = await axios.post(
        `https://api.track.toggl.com/api/v9/workspaces/${workspaceId}/time_entries`,
        {
          description: breakDescription,
          workspace_id: workspaceId,
          start: new Date().toISOString(),
          duration: -1,
          created_with: 'toggl-track-vscode',
          billable: false, // Breaks are not billable
        },
        {
          auth: { username: apiToken, password: 'api_token' },
        }
      );

      this.currentEntryId = response.data.id;
      this.currentDescription = breakDescription;
      this.isOnBreak = true;
      this.isTracking = false; // Pause auto-tracking during break
      
      this.updateStatusBar(`$(coffee) Toggl: ${breakDescription}`);
      this.updateBreakButton();
      
      vscode.window.showInformationMessage(`Break started: ${breakDescription}`);
    } catch (error) {
      console.error('Failed to start break:', error);
      vscode.window.showErrorMessage('Toggl: Failed to start break');
    }
  }

  async endBreak() {
    const config = this.getConfig();
    const apiToken = config.get<string>('apiToken');
    const workspaceId = config.get<number>('workspaceId');

    if (!apiToken || !workspaceId) return;

    // Stop break entry
    await this.stopCurrentEntry();

    this.isOnBreak = false;
    this.isTracking = true; // Resume auto-tracking
    this.updateBreakButton();

    // Resume previous task
    if (this.preBreakBranch) {
      this.currentBranch = ''; // Force restart
      await this.checkBranch();
      vscode.window.showInformationMessage('Break ended - resumed tracking');
    } else {
      this.updateStatusBar('$(clock) Toggl: Ready');
    }

    // Clear pre-break state
    this.preBreakEntryId = null;
    this.preBreakDescription = '';
    this.preBreakBranch = '';
  }

  dispose() {
    // Stop tracking and timer synchronously as much as possible
    this.isTracking = false;
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
    if (this.idleCheckInterval) {
      clearInterval(this.idleCheckInterval);
      this.idleCheckInterval = null;
    }
    // Fire the stop request (don't await - extension may close before it completes)
    this.stopCurrentEntry().catch(() => {});
    this.statusBarItem.dispose();
    this.newBranchStatusBarItem.dispose();
    this.breakStatusBarItem.dispose();
  }
}

let tracker: TogglTracker;

const GITHUB_REPO = 'alexdeg92/toggl-track-vscode';

async function checkForUpdates(context: vscode.ExtensionContext) {
  try {
    const extension = vscode.extensions.getExtension('pivot.toggl-track-auto');
    const currentVersion = extension?.packageJSON?.version || '0.0.0';
    
    const response = await axios.get(
      `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`,
      { headers: { 'Accept': 'application/vnd.github.v3+json' } }
    );
    
    const latestVersion = response.data.tag_name?.replace('v', '') || '0.0.0';
    const vsixAsset = response.data.assets?.find((a: any) => a.name.endsWith('.vsix'));
    
    if (latestVersion > currentVersion && vsixAsset) {
      const action = await vscode.window.showInformationMessage(
        `Toggl Track Auto v${latestVersion} is available (you have v${currentVersion})`,
        'Download & Install',
        'Later'
      );
      
      if (action === 'Download & Install') {
        // Download the VSIX
        const downloadPath = path.join(context.globalStorageUri.fsPath, vsixAsset.name);
        await vscode.workspace.fs.createDirectory(context.globalStorageUri);
        
        const vsixResponse = await axios.get(vsixAsset.browser_download_url, {
          responseType: 'arraybuffer'
        });
        
        await vscode.workspace.fs.writeFile(
          vscode.Uri.file(downloadPath),
          new Uint8Array(vsixResponse.data)
        );
        
        // Install the extension
        await vscode.commands.executeCommand(
          'workbench.extensions.installExtension',
          vscode.Uri.file(downloadPath)
        );
        
        const reload = await vscode.window.showInformationMessage(
          `Toggl Track Auto v${latestVersion} installed! Reload to activate.`,
          'Reload Now'
        );
        
        if (reload === 'Reload Now') {
          await vscode.commands.executeCommand('workbench.action.reloadWindow');
        }
      }
    }
  } catch (error) {
    console.error('Failed to check for updates:', error);
  }
}

export async function activate(context: vscode.ExtensionContext) {
  tracker = new TogglTracker();

  // ========== Monday.com Sidebar TreeView ==========
  const mondayTreeProvider = new MondayTaskTreeProvider();
  const mondaySidebarController = new MondaySidebarController(mondayTreeProvider);
  tracker.mondaySidebarController = mondaySidebarController;

  // Rich webview sidebar
  const mondayWebviewProvider = new MondayWebviewProvider(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('togglMondayWebview', mondayWebviewProvider)
  );
  mondaySidebarController.setWebviewProvider(mondayWebviewProvider);

  // Set context for view visibility (will be controlled by org check in tracker.start())
  vscode.commands.executeCommand('setContext', 'togglMondayTask.visible', true);
  
  // Check for updates on startup (after 5 seconds to not slow down activation)
  setTimeout(() => checkForUpdates(context), 5000);

  context.subscriptions.push(
    vscode.commands.registerCommand('toggl-track-auto.start', () => tracker.start()),
    vscode.commands.registerCommand('toggl-track-auto.stop', () => tracker.stop()),
    vscode.commands.registerCommand('toggl-track-auto.status', () => tracker.showStatus()),
    vscode.commands.registerCommand('toggl-track-auto.toggleBreak', () => tracker.toggleBreak()),
    vscode.commands.registerCommand('toggl-track-auto.setup', async () => {
      const success = await runSetupWizard();
      if (success) {
        tracker.start();
      }
    }),
    // Monday.com integration commands
    vscode.commands.registerCommand('toggl-track-auto.createBranchFromTask', () => createBranchFromTask()),
    vscode.commands.registerCommand('toggl-track-auto.copyMondayTaskLink', () => copyMondayTaskLink()),
    // Open update in editor
    vscode.commands.registerCommand('toggl-track-auto.openUpdate', async (text: string) => {
      const doc = await vscode.workspace.openTextDocument({ content: text, language: 'markdown' });
      await vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.Beside });
    }),

    // New commands for v0.20.0
    vscode.commands.registerCommand('toggl-track-auto.refreshTaskContext', async () => {
      // Debug: show what we detect
      const root = getWorkspaceRoot();
      const branch = await getCurrentBranchName();
      const taskId = branch ? resolveTaskIdForBranch(branch) : null;
      const token = getMondayToken();

      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Refreshing Monday.com task context...' },
        async () => {
          await mondaySidebarController.forceRefresh();
        }
      );

      const debugInfo = [
        `Root: ${root || 'NOT FOUND'}`,
        `Branch: ${branch || 'NOT FOUND'}`,
        `Task ID: ${taskId || 'NOT FOUND'}`,
        `Monday Token: ${token ? 'SET (' + token.substring(0, 20) + '...)' : 'NOT SET'}`,
      ].join(' | ');
      vscode.window.showInformationMessage(`Monday refresh: ${debugInfo}`);
    }),
    vscode.commands.registerCommand('toggl-track-auto.refreshMondaySidebar', async () => {
      await mondaySidebarController.forceRefresh();
    }),
  );

  // Add tracker to subscriptions for proper disposal
  context.subscriptions.push(tracker);

  // Check if setup is needed
  const config = vscode.workspace.getConfiguration('togglTrackAuto');
  if (!config.get<string>('apiToken')) {
    const success = await runSetupWizard();
    if (success) {
      tracker.start();
    }
  } else {
    // Auto-start if already configured
    tracker.start();
  }

  // On startup, check if current branch has a Monday task and update hook + sidebar
  setTimeout(async () => {
    checkBranchForMondayLink();
    // Initial sidebar update
    mondaySidebarController.update();
  }, 3000);
}

export function deactivate() {
  if (tracker) {
    tracker.dispose();
  }
}
