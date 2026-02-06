import * as vscode from 'vscode';
import axios from 'axios';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// Monday.com API token - must be set via MONDAY_TOKEN env var or settings
function getMondayToken(): string {
  return process.env.MONDAY_TOKEN || vscode.workspace.getConfiguration('togglTrackAuto').get<string>('mondayToken') || '';
}

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

    // Handle window focus - only active window manages Toggl
    vscode.window.onDidChangeWindowState((state) => {
      if (state.focused) {
        console.log('Window focused - taking over Toggl management');
        this.checkBranch(); // Re-check and take over
      } else {
        console.log('Window lost focus - pausing Toggl management');
        // Don't stop the timer, just pause local management
        // The focused window will take over
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

  // Find previous Toggl entry with same description to reuse project/tags
  private async getPreviousEntrySettings(description: string): Promise<{ projectId: number | null, tags: string[] }> {
    const config = this.getConfig();
    const apiToken = config.get<string>('apiToken');
    const workspaceId = config.get<number>('workspaceId');
    
    if (!apiToken || !workspaceId) return { projectId: null, tags: [] };
    
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
      
      // Find entry with matching description
      const entries = response.data || [];
      const matchingEntry = entries.find((e: any) => e.description === description);
      
      if (matchingEntry) {
        return {
          projectId: matchingEntry.project_id || null,
          tags: matchingEntry.tags || [],
        };
      }
    } catch (error) {
      console.error('Failed to fetch previous Toggl entries:', error);
    }
    
    return { projectId: null, tags: [] };
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

    // Sync with current Toggl state (handles multi-window scenarios)
    const currentTogglEntry = await this.getCurrentTogglEntry();
    if (currentTogglEntry && currentTogglEntry.id) {
      // There's already a running timer - adopt it if we don't have one
      if (!this.currentEntryId) {
        this.currentEntryId = currentTogglEntry.id;
        this.currentDescription = currentTogglEntry.description || '';
        this.updateStatusBar(`$(clock) Toggl: ${this.currentDescription.substring(0, 30)}...`);
      }
      // If the running timer matches our branch context, we're good
      // If not, another window is controlling it - don't interfere
      if (this.currentEntryId !== currentTogglEntry.id) {
        // Another window started a different timer - sync to it
        this.currentEntryId = currentTogglEntry.id;
        this.currentDescription = currentTogglEntry.description || '';
        this.currentBranch = branch; // Avoid restarting
        this.updateStatusBar(`$(clock) Toggl: ${this.currentDescription.substring(0, 30)}...`);
        return;
      }
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
    
    // Look up previous Toggl entries with same description to reuse project/tags
    const previousSettings = await this.getPreviousEntrySettings(description);
    if (previousSettings.projectId) {
      projectId = previousSettings.projectId;
    }
    if (previousSettings.tags.length > 0) {
      tags = previousSettings.tags;
    }

    try {
      // Check if we should resume a recent entry (same task, stopped within 10 min)
      const tenMinutesMs = 10 * 60 * 1000;
      const timeSinceLastStop = Date.now() - this.lastStoppedTime;
      
      if (
        this.lastStoppedEntryId &&
        this.lastStoppedDescription === description &&
        timeSinceLastStop < tenMinutesMs
      ) {
        // Resume the previous entry by restarting it
        console.log('Resuming previous Toggl entry');
        
        // Get the old entry and create a new one continuing from it
        const response = await axios.post(
          `https://api.track.toggl.com/api/v9/workspaces/${workspaceId}/time_entries`,
          {
            description,
            workspace_id: workspaceId,
            start: new Date().toISOString(),
            duration: -1,
            created_with: 'toggl-track-vscode',
            billable: true,
            ...(projectId && projectId > 0 ? { project_id: projectId } : {}),
            ...(tags.length > 0 ? { tags } : {}),
          },
          {
            auth: { username: apiToken, password: 'api_token' },
          }
        );
        
        this.currentEntryId = response.data.id;
        this.currentDescription = description;
        this.updateStatusBar(`$(clock) Toggl: ${description.substring(0, 30)}... (resumed)`);
        return;
      }

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
