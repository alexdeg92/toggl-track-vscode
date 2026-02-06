import * as vscode from 'vscode';
import axios from 'axios';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

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

  // Step 2: Monday.com (optional)
  const mondaySetup = await vscode.window.showInformationMessage(
    '📋 Step 2 (Optional): Add Monday.com integration for task names?',
    'Yes, add Monday.com',
    'Skip'
  );

  if (mondaySetup === 'Yes, add Monday.com') {
    const mondayInfo = await vscode.window.showInformationMessage(
      'Get your Monday.com API token from: monday.com → Profile → Admin → API',
      'Open Monday.com',
      'I have it'
    );

    if (mondayInfo === 'Open Monday.com') {
      vscode.env.openExternal(vscode.Uri.parse('https://monday.com'));
    }

    const mondayToken = await vscode.window.showInputBox({
      prompt: 'Enter your Monday.com API token (or leave empty to skip)',
      placeHolder: 'eyJhbGciOiJIUzI1NiJ9...',
      password: true,
      ignoreFocusOut: true,
    });

    if (mondayToken) {
      await config.update('mondayApiToken', mondayToken, vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage('✅ Monday.com integration added!');
    }
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
  private currentBranch: string = '';
  private currentEntryId: number | null = null;
  private lastActivity: number = Date.now();
  private checkInterval: NodeJS.Timeout | null = null;
  private idleCheckInterval: NodeJS.Timeout | null = null;
  private isTracking: boolean = false;
  private taskCache: Map<string, string> = new Map();

  constructor() {
    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      100
    );
    this.statusBarItem.command = 'toggl-track-auto.status';
    this.statusBarItem.show();
    this.updateStatusBar('$(clock) Toggl: Initializing...');
  }

  private getConfig() {
    return vscode.workspace.getConfiguration('togglTrackAuto');
  }

  private updateStatusBar(text: string) {
    this.statusBarItem.text = text;
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
    const mondayToken = config.get<string>('mondayApiToken');
    
    if (!mondayToken) {
      return null;
    }

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

    this.currentEntryId = null;
  }

  private async startNewEntry(branch: string) {
    const config = this.getConfig();
    const apiToken = config.get<string>('apiToken');
    const workspaceId = config.get<number>('workspaceId');
    const projectId = config.get<number>('projectId');

    if (!apiToken || !workspaceId) return;

    const ticketId = this.extractTicketId(branch);
    let description = branch;

    if (ticketId) {
      const taskName = await this.getMondayTaskName(ticketId);
      const format = config.get<string>('entryFormat') || '[{ticket_id}] {task_name}';
      
      if (taskName) {
        description = format
          .replace('{ticket_id}', ticketId)
          .replace('{task_name}', taskName)
          .replace('{branch}', branch);
      } else {
        description = `[${ticketId}] ${branch}`;
      }
    }

    try {
      const payload: any = {
        description,
        workspace_id: workspaceId,
        start: new Date().toISOString(),
        duration: -1, // Running timer
        created_with: 'toggl-track-vscode',
      };

      if (projectId && projectId > 0) {
        payload.project_id = projectId;
      }

      const response = await axios.post(
        `https://api.track.toggl.com/api/v9/workspaces/${workspaceId}/time_entries`,
        payload,
        {
          auth: { username: apiToken, password: 'api_token' },
        }
      );

      this.currentEntryId = response.data.id;
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

  dispose() {
    this.stop();
    this.statusBarItem.dispose();
  }
}

let tracker: TogglTracker;

export async function activate(context: vscode.ExtensionContext) {
  tracker = new TogglTracker();

  context.subscriptions.push(
    vscode.commands.registerCommand('toggl-track-auto.start', () => tracker.start()),
    vscode.commands.registerCommand('toggl-track-auto.stop', () => tracker.stop()),
    vscode.commands.registerCommand('toggl-track-auto.status', () => tracker.showStatus()),
    vscode.commands.registerCommand('toggl-track-auto.setup', async () => {
      const success = await runSetupWizard();
      if (success) {
        tracker.start();
      }
    })
  );

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
}

export function deactivate() {
  if (tracker) {
    tracker.dispose();
  }
}
