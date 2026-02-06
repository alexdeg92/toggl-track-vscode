import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import axios from 'axios';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// Monday.com API token - must be set via MONDAY_TOKEN env var or settings
function getMondayToken(): string {
  return process.env.MONDAY_TOKEN || vscode.workspace.getConfiguration('togglTrackAuto').get<string>('mondayApiToken') || vscode.workspace.getConfiguration('togglTrackAuto').get<string>('mondayToken') || '';
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
    const gitignorePath = path.join(root, '.gitignore');
    const entry = '.vscode/monday-tasks.json';
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
}

async function fetchCurrentMondayUserId(token: string): Promise<number | null> {
  try {
    const response = await axios.post(MONDAY_API_URL, {
      query: '{ me { id } }',
    }, {
      headers: {
        'Authorization': token,
        'Content-Type': 'application/json',
      },
    });
    return response.data?.data?.me?.id || null;
  } catch (error) {
    console.error('Failed to fetch Monday user ID:', error);
    return null;
  }
}

async function fetchUserTasks(token: string, boardId: string): Promise<MondayTask[]> {
  try {
    // Get current user ID
    const userId = await fetchCurrentMondayUserId(token);
    if (!userId) {
      vscode.window.showErrorMessage('Monday.com: Could not determine current user. Check your MONDAY_TOKEN.');
      return [];
    }

    // Fetch all items from the board, filtering by person column
    const query = `
      query {
        boards(ids: [${boardId}]) {
          items_page(limit: 100, query_params: {rules: [{column_id: "person", compare_value: [${userId}]}], operator: and}) {
            items {
              id
              name
              group {
                title
              }
              column_values(ids: ["status"]) {
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

    // Filter out "Done" items
    return items
      .filter((item: any) => {
        const status = item.column_values?.[0]?.text || '';
        return status.toLowerCase() !== 'done';
      })
      .map((item: any) => ({
        id: item.id,
        name: item.name,
        boardId,
      }));
  } catch (error: any) {
    console.error('Failed to fetch Monday tasks:', error);
    vscode.window.showErrorMessage(`Monday.com API error: ${error.message || 'Unknown error'}`);
    return [];
  }
}

function generatePrepareCommitMsgHook(taskId: string, boardId: string): string {
  const url = getMondayTaskUrl(boardId, taskId);
  return `#!/bin/sh
# Auto-generated by Toggl Track Auto - Monday.com integration
# Links commits to Monday task: ${url}

COMMIT_MSG_FILE=$1
COMMIT_SOURCE=$2

# Don't modify merge commits or amended commits
if [ "$COMMIT_SOURCE" = "merge" ] || [ "$COMMIT_SOURCE" = "squash" ]; then
  exit 0
fi

# Check if the Monday link is already in the message
if grep -q "Monday task: ${url}" "$COMMIT_MSG_FILE" 2>/dev/null; then
  exit 0
fi

# Append the Monday task link
echo "" >> "$COMMIT_MSG_FILE"
echo "Monday task: ${url}" >> "$COMMIT_MSG_FILE"
`;
}

async function installPrepareCommitMsgHook(taskId: string, boardId: string): Promise<boolean> {
  const root = getWorkspaceRoot();
  if (!root) return false;

  const hooksDir = path.join(root, '.git', 'hooks');
  const hookPath = path.join(hooksDir, 'prepare-commit-msg');

  try {
    // Ensure hooks directory exists
    if (!fs.existsSync(hooksDir)) {
      fs.mkdirSync(hooksDir, { recursive: true });
    }

    // Check if hook already exists and wasn't created by us
    if (fs.existsSync(hookPath)) {
      const existing = fs.readFileSync(hookPath, 'utf-8');
      if (!existing.includes('Toggl Track Auto - Monday.com integration')) {
        // Backup existing hook
        const backupPath = hookPath + '.backup';
        fs.writeFileSync(backupPath, existing);
        console.log(`Backed up existing prepare-commit-msg hook to ${backupPath}`);
      }
    }

    const hookContent = generatePrepareCommitMsgHook(taskId, boardId);
    fs.writeFileSync(hookPath, hookContent, { mode: 0o755 });
    return true;
  } catch (error) {
    console.error('Failed to install prepare-commit-msg hook:', error);
    return false;
  }
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
    vscode.window.showInformationMessage('No open Monday.com tasks found assigned to you.');
    return;
  }

  // Show QuickPick
  const items = tasks.map(task => ({
    label: task.name,
    description: `#${task.id}`,
    task,
  }));

  const selected = await vscode.window.showQuickPick(items, {
    placeHolder: 'Select a Monday.com task to create a branch for',
    matchOnDescription: true,
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
  const hookInstalled = await installPrepareCommitMsgHook(task.id, task.boardId);

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
      await installPrepareCommitMsgHook(mapping.taskId, mapping.boardId);
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
   * Supports both SSH (git@github.com:org/repo.git) and HTTPS (https://github.com/org/repo.git).
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
   * Caches the result per workspace folder to avoid repeated git calls.
   * Returns true if allowedOrgs is empty (no filtering).
   */
  private async checkOrgAllowed(): Promise<boolean> {
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
      return;
    }

    this.statusBarItem.show();
    this.newBranchStatusBarItem.show();
    this.breakStatusBarItem.show();
    this.isTracking = true;
    await this.checkBranch();

    // Check branch every 10 seconds
    this.checkInterval = setInterval(() => this.checkBranch(), 10000);

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
      } else {
        this.statusBarItem.show();
        this.newBranchStatusBarItem.show();
        this.breakStatusBarItem.show();
        if (!this.isTracking) {
          await this.start();
        }
      }
    });

    // Handle window focus - focused window takes over Toggl
    vscode.window.onDidChangeWindowState(async (state) => {
      if (state.focused && this.isTracking) {
        console.log('Window focused - taking over Toggl tracking (v0.12.1)');
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
    const config = this.getConfig();
    const pattern = config.get<string>('branchPattern') || '(\\d{6,})';
    const regex = new RegExp(pattern);
    const match = branch.match(regex);
    return match ? match[1] : null;
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

    // Sync local state with Toggl (but don't prevent switching)
    const currentTogglEntry = await this.getCurrentTogglEntry();
    if (currentTogglEntry && currentTogglEntry.id) {
      // Track what Toggl is currently running
      this.currentEntryId = currentTogglEntry.id;
      this.currentDescription = currentTogglEntry.description || '';
    }

    // Resume tracking if we were idle
    if (!this.currentEntryId && Date.now() - this.lastActivity < 30000) {
      // Branch hasn't changed but we need to restart tracking
      this.currentBranch = ''; // Force restart
    }

    if (branch !== this.currentBranch) {
      this.currentBranch = branch;
      await this.stopCurrentEntry();
      await this.startNewEntry(branch);
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
    const workspaceId = config.get<number>('workspaceId');

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
    } catch (error) {
      vscode.window.showErrorMessage('Toggl: Failed to fetch status');
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

  // On startup, check if current branch has a Monday task and update hook
  setTimeout(() => checkBranchForMondayLink(), 3000);
}

export function deactivate() {
  if (tracker) {
    tracker.dispose();
  }
}
