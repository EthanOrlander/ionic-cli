import { MetadataGroup, validators } from '@ionic/cli-framework';
import { isValidURL, slugify } from '@ionic/cli-framework/utils/string';
import { mkdir, pathExists, remove, unlink } from '@ionic/utils-fs';
import { columnar, prettyPath } from '@ionic/utils-terminal';
import * as chalk from 'chalk';
import * as Debug from 'debug';
import * as path from 'path';

import { COLUMNAR_OPTIONS, PROJECT_FILE } from '../constants';
import { CommandInstanceInfo, CommandLineInputs, CommandLineOptions, CommandMetadata, CommandPreRun, IProject, IShellRunOptions, ProjectType, ResolvedStarterTemplate, StarterManifest } from '../definitions';
import { failure, input, strong } from '../lib/color';
import { Command } from '../lib/command';
import { FatalException } from '../lib/errors';
import { runCommand } from '../lib/executor';
import { createProjectFromDetails, createProjectFromDirectory, isValidProjectId } from '../lib/project';
import { promptToSignup } from '../lib/session';
import { prependNodeModulesBinToPath } from '../lib/shell';
import { AppSchema, STARTER_BASE_URL, STARTER_TEMPLATES, SUPPORTED_FRAMEWORKS, getAdvertisement, getStarterList, getStarterProjectTypes, readStarterManifest, verifyOptions } from '../lib/start';
import { emoji } from '../lib/utils/emoji';
import { createRequest } from '../lib/utils/http';

const debug = Debug('ionic:commands:start');

interface StartWizardApp {
  type: ProjectType;
  name: string;
  appId: string;
  template: string;
  'package-id': string;
  tid: string;
  email: string;
  theme: string;
  ip: string;
  appIcon: string;
  appSplash: string;
  utm: { [key: string]: string };
}

export class StartCommand extends Command implements CommandPreRun {
  private canRemoveExisting = false;

  private schema?: AppSchema;

  async getMetadata(): Promise<CommandMetadata> {
    return {
      name: 'start',
      type: 'global',
      summary: 'Create a new project',
      description: `
This command creates a working Ionic app. It installs dependencies for you and sets up your project.

Running ${input('ionic start')} without any arguments will prompt you for information about your new project.

The first argument is your app's ${input('name')}. Don't worry--you can always change this later. The ${input('--project-id')} is generated from ${input('name')} unless explicitly specified.

The second argument is the ${input('template')} from which to generate your app. You can list all templates with the ${input('--list')} option. You can also specify a git repository URL for ${input('template')}, in which case the existing project will be cloned.

Use the ${input('--type')} option to start projects using older versions of Ionic. For example, you can start an Ionic 3 project with ${input('--type=ionic-angular')}. Use ${input('--list')} to see all project types and templates.
      `,
      exampleCommands: [
        '',
        '--list',
        'myApp',
        'myApp blank',
        'myApp tabs --cordova',
        'myApp tabs --capacitor',
        'myApp super --type=ionic-angular',
        'myApp blank --type=ionic1',
        'cordovaApp tabs --cordova',
        '"My App" blank',
        '"Conference App" https://github.com/ionic-team/ionic-conference-app',
      ],
      inputs: [
        {
          name: 'name',
          summary: `The name of your new project (e.g. ${input('myApp')}, ${input('"My App"')})`,
          validators: [validators.required],
        },
        {
          name: 'template',
          summary: `The starter template to use (e.g. ${['blank', 'tabs'].map(t => input(t)).join(', ')}; use ${input('--list')} to see all)`,
          validators: [validators.required],
        },
      ],
      options: [
        {
          name: 'list',
          summary: 'List available starter templates',
          type: Boolean,
          aliases: ['l'],
        },
        {
          name: 'type',
          summary: `Type of project to start (e.g. ${getStarterProjectTypes().map(type => input(type)).join(', ')})`,
          type: String,
        },
        {
          name: 'cordova',
          summary: 'Include Cordova integration',
          type: Boolean,
          groups: [MetadataGroup.DEPRECATED]
        },
        {
          name: 'capacitor',
          summary: 'Include Capacitor integration',
          type: Boolean,
        },
        {
          name: 'no-deps',
          summary: 'Do not install npm/yarn dependencies',
          type: Boolean,
          default: true,
          groups: [MetadataGroup.ADVANCED],
        },
        {
          name: 'no-git',
          summary: 'Do not initialize a git repo',
          type: Boolean,
          default: true,
          groups: [MetadataGroup.ADVANCED],
        },
        {
          name: 'link',
          summary: 'Connect your new app to Ionic',
          type: Boolean,
          groups: [MetadataGroup.ADVANCED],
        },
        {
          name: 'id',
          summary: 'Specify an Ionic App ID to link',
        },
        {
          name: 'project-id',
          summary: 'Specify a slug for your app (used for the directory name and package name)',
          groups: [MetadataGroup.ADVANCED],
          spec: { value: 'slug' },
        },
        {
          name: 'package-id',
          summary: 'Specify the bundle ID/application ID for your app (reverse-DNS notation)',
          groups: [MetadataGroup.ADVANCED],
          spec: { value: 'id' },
        },
        {
          name: 'start-id',
          summary: 'Used by the Ionic app start experience to generate an associated app locally',
          groups: [MetadataGroup.HIDDEN],
          spec: { value: 'id' },
        },
        {
          name: 'tag',
          summary: `Specify a tag to use for the starters (e.g. ${['latest', 'testing', 'next'].map(t => input(t)).join(', ')})`,
          default: 'latest',
          groups: [MetadataGroup.HIDDEN],
        },
      ],
    };
  }

  async startIdStart(inputs: CommandLineInputs, options: CommandLineOptions) {
    const startId = options['start-id'];

    const wizardApiUrl = process.env.START_WIZARD_URL_BASE || `https://ionicframework.com`;

    const { req } = await createRequest('GET', `${wizardApiUrl}/api/v1/wizard/app/${startId}`, this.env.config.getHTTPConfig());

    const error = (e?: Error) => {
      this.env.log.error(`No such app ${chalk.bold(startId)}. This app configuration may have expired. Please retry at https://ionicframework.com/start`);
      if (e) {
        throw e;
      }
    };

    let data: StartWizardApp;
    try {
      const ret = await req;
      if (ret.status !== 200) {
        return error();
      }

      data = (await req).body as StartWizardApp;

      if (!data) {
        return error();
      }
    } catch (e) {
      return error(e);
    }

    let projectDir = slugify(data.name);
    if (inputs.length === 1) {
      projectDir = inputs[0];
    }

    await this.checkForExisting(projectDir);

    inputs.push(data.name);
    inputs.push(data.template);

    await this.startIdConvert(startId as string);

    const appIconBuffer = data.appIcon ?
      Buffer.from(data.appIcon.replace(/^data:image\/\w+;base64,/, ''), 'base64') :
      undefined;

    const splashBuffer = data.appSplash ?
      Buffer.from(data.appSplash.replace(/^data:image\/\w+;base64,/, ''), 'base64') :
      undefined;

    this.schema = {
      cloned: false,
      name: data.name,
      type: data.type,
      template: data.template,
      projectId: slugify(data.name),
      projectDir,
      packageId: data['package-id'],
      appflowId: undefined,
      appIcon: appIconBuffer,
      splash: splashBuffer,
      themeColor: data.theme,
    };
  }

  async startIdConvert(id: string) {
    const wizardApiUrl = process.env.START_WIZARD_URL_BASE || `https://ionicframework.com`;

    if (!wizardApiUrl) {
      return;
    }

    const { req } = await createRequest('POST', `${wizardApiUrl}/api/v1/wizard/app/${id}/start`, this.env.config.getHTTPConfig());

    try {
      await req;
    } catch (e) {
      this.env.log.warn(`Unable to set app flag on server: ${e.message}`);
    }
  }

  /**
   * Check if we should use the wizard for the start command.
   * We should use if they ran `ionic start` or `ionic start --capacitor`
   * and they are in an interactive environment.
   */
  async shouldUseStartWizard(inputs: CommandLineInputs, options: CommandLineOptions) {
    const flagsToTestFor = [
      'list',
      'l',
      'cordova',
      'link',
      'help',
      'h',
      'type',
      'id',
      'project-id',
      'package-id',
      'start-id',
    ];

    let didUseFlags = false ;

    for (const key of flagsToTestFor) {
      if (options[key] !== null) {
        didUseFlags = true;
        break;
      }
    }

    return inputs.length === 0 && options['interactive'] && options['deps'] && options['git'] && !didUseFlags;
  }

  async preRun(inputs: CommandLineInputs, options: CommandLineOptions): Promise<void> {
    const { promptToLogin } = await import('../lib/session');

    verifyOptions(options, this.env);

    if (await this.shouldUseStartWizard(inputs, options)) {
      const confirm = await this.env.prompt({
        type: 'confirm',
        name: 'confirm',
        message: 'Use the app creation wizard?',
        default: true,
      });

      if (confirm) {
        const startId = await this.env.session.wizardLogin();
        if (!startId) {
          this.env.log.error('There was an issue using the web wizard. Falling back to CLI wizard.');
        } else {
          options['start-id'] = startId;
        }
      }
    }

    const appflowId = options['id'] ? String(options['id']) : undefined;

    if (appflowId) {
      if (!this.env.session.isLoggedIn()) {
        await promptToLogin(this.env);
      }
    }

    // The start wizard pre-populates all arguments for the CLI
    if (options['start-id']) {
      await this.startIdStart(inputs, options);
      return;
    }

    const projectType = isValidURL(inputs[1]) ? 'custom' : options['type'] ? String(options['type']) : await this.getProjectType();

    if (options['cordova']) {
      const { checkForUnsupportedProject } = await import('../lib/integrations/cordova/utils');

      try {
        await checkForUnsupportedProject(projectType as ProjectType);
      } catch (e) {
        this.env.log.error(e.message);
        options['cordova'] = false;
      }
    }

    if (!inputs[0]) {
      if (appflowId) {
        const { AppClient } = await import('../lib/app');
        const token = await this.env.session.getUserToken();
        const appClient = new AppClient(token, this.env);
        const tasks = this.createTaskChain();
        tasks.next(`Looking up app ${input(appflowId)}`);
        const app = await appClient.load(appflowId);
        // TODO: can ask to clone via repo_url
        tasks.end();
        this.env.log.info(`Using ${strong(app.name)} for ${input('name')} and ${strong(app.slug)} for ${input('--project-id')}.`);
        inputs[0] = app.name;
        options['project-id'] = app.slug;
      } else {
        if (this.env.flags.interactive) {
          this.env.log.nl();
          this.env.log.msg(
            `${strong(`Every great app needs a name! ${emoji('😍', '')}`)}\n` +
            `Please enter the full name of your app. You can change this at any time. To bypass this prompt next time, supply ${input('name')}, the first argument to ${input('ionic start')}.\n\n`
          );
        }

        const name = await this.env.prompt({
          type: 'input',
          name: 'name',
          message: 'Project name:',
          validate: v => validators.required(v),
        });

        inputs[0] = name;
      }
    }

    if (!inputs[1]) {
      if (this.env.flags.interactive) {
        this.env.log.nl();
        this.env.log.msg(
          `${strong(`Let's pick the perfect starter template! ${emoji('💪', '')}`)}\n` +
          `Starter templates are ready-to-go Ionic apps that come packed with everything you need to build your app. To bypass this prompt next time, supply ${input('template')}, the second argument to ${input('ionic start')}.\n\n`
        );
      }

      const template = await this.env.prompt({
        type: 'list',
        name: 'template',
        message: 'Starter template:',
        choices: () => {
          const starterTemplateList = STARTER_TEMPLATES.filter(st => st.projectType === projectType);
          const cols = columnar(starterTemplateList.map(({ name, description }) => [input(name), description || '']), COLUMNAR_OPTIONS).split('\n');

          if (starterTemplateList.length === 0) {
            throw new FatalException(`No starter templates found for project type: ${input(projectType)}.`);
          }

          return starterTemplateList.map((starter, i) => {
            return {
              name: cols[i],
              short: starter.name,
              value: starter.name,
            };
          });
        },
      });

      inputs[1] = template;
    }

    const starterTemplate = STARTER_TEMPLATES.find(t => t.name === inputs[1] && t.projectType === projectType);

    if (starterTemplate && starterTemplate.type === 'repo') {
      inputs[1] = starterTemplate.repo;
    }

    const cloned = isValidURL(inputs[1]);

    if (this.project && this.project.details.context === 'app') {
      const confirm = await this.env.prompt({
        type: 'confirm',
        name: 'confirm',
        message: 'You are already in an Ionic project directory. Do you really want to start another project here?',
        default: false,
      });

      if (!confirm) {
        this.env.log.info('Not starting project within existing project.');
        throw new FatalException();
      }
    }

    await this.validateProjectType(projectType);

    if (cloned) {
      if (!options['git']) {
        this.env.log.warn(`The ${input('--no-git')} option has no effect when cloning apps. Git must be used.`);
      }

      options['git'] = true;
    }

    if (options['v1'] || options['v2']) {
      throw new FatalException(
        `The ${input('--v1')} and ${input('--v2')} flags have been removed.\n` +
        `Use the ${input('--type')} option. (see ${input('ionic start --help')})`
      );
    }

    if (options['app-name']) {
      this.env.log.warn(`The ${input('--app-name')} option has been removed. Use the ${input('name')} argument with double quotes: e.g. ${input('ionic start "My App"')}`);
    }

    if (options['display-name']) {
      this.env.log.warn(`The ${input('--display-name')} option has been removed. Use the ${input('name')} argument with double quotes: e.g. ${input('ionic start "My App"')}`);
    }

    if (options['bundle-id']) {
      this.env.log.warn(`The ${input('--bundle-id')} option has been deprecated. Please use ${input('--package-id')}.`);
      options['package-id'] = options['bundle-id'];
    }

    let projectId = options['project-id'] ? String(options['project-id']) : undefined;

    if (projectId) {
      await this.validateProjectId(projectId);
    } else {
      projectId = options['project-id'] = isValidProjectId(inputs[0]) ? inputs[0] : slugify(inputs[0]);
    }

    const projectDir = path.resolve(projectId);
    const packageId = options['package-id'] ? String(options['package-id']) : undefined;

    if (projectId) {
      await this.checkForExisting(projectDir);
    }

    if (cloned) {
      this.schema = {
        cloned: true,
        url: inputs[1],
        projectId,
        projectDir,
      };
    } else {
      this.schema = {
        cloned: false,
        name: inputs[0],
        type: projectType as ProjectType,
        template: inputs[1],
        projectId,
        projectDir,
        packageId,
        appflowId,
        themeColor: undefined,
      };
    }
  }

  async getProjectType() {
    if (this.env.flags.interactive) {
      this.env.log.nl();
      this.env.log.msg(
        `${strong(`Pick a framework! ${emoji('😁', '')}`)}\n\n` +
        `Please select the JavaScript framework to use for your new app. To bypass this prompt next time, supply a value for the ${input('--type')} option.\n\n`
      );
    }

    const frameworkChoice = await this.env.prompt({
      type: 'list',
      name: 'frameworks',
      message: 'Framework:',
      default: 'angular',
      choices: () => {
        const cols = columnar(SUPPORTED_FRAMEWORKS.map(({ name, description }) => [input(name), description]), COLUMNAR_OPTIONS).split('\n');
        return SUPPORTED_FRAMEWORKS.map((starterTemplate, i) => {
          return {
            name: cols[i],
            short: starterTemplate.name,
            value: starterTemplate.type,
          };
        });
      },
    });

    return frameworkChoice;
  }

  async run(inputs: CommandLineInputs, options: CommandLineOptions, runinfo: CommandInstanceInfo): Promise<void> {
    const { pkgManagerArgs } = await import('../lib/utils/npm');
    const { getTopLevel, isGitInstalled } = await import('../lib/git');

    if (!this.schema) {
      throw new FatalException(`Invalid start schema: cannot start app.`);
    }

    const { projectId, projectDir, packageId, appflowId } = this.schema;

    const tag = options['tag'] ? String(options['tag']) : 'latest';
    let linkConfirmed = typeof appflowId === 'string';

    const gitDesired = options['git'] ? true : false;
    const gitInstalled = await isGitInstalled(this.env);
    const gitTopLevel = await getTopLevel(this.env);

    let gitIntegration = gitDesired && gitInstalled && !gitTopLevel ? true : false;

    if (!gitInstalled) {
      const installationDocs = `See installation docs for git: ${strong('https://git-scm.com/book/en/v2/Getting-Started-Installing-Git')}`;

      if (appflowId) {
        throw new FatalException(
          `Git CLI not found on your PATH.\n` +
          `Git must be installed to connect this app to Ionic. ${installationDocs}`
        );
      }

      if (this.schema.cloned) {
        throw new FatalException(
          `Git CLI not found on your PATH.\n` +
          `Git must be installed to clone apps with ${input('ionic start')}. ${installationDocs}`
        );
      }
    }

    if (gitTopLevel && !this.schema.cloned) {
      this.env.log.info(`Existing git project found (${strong(gitTopLevel)}). Git operations are disabled.`);
    }

    const tasks = this.createTaskChain();
    tasks.next(`Preparing directory ${input(prettyPath(projectDir))}`);

    if (this.canRemoveExisting) {
      await remove(projectDir);
    }

    await mkdir(projectDir);

    tasks.end();

    if (this.schema.cloned) {
      await this.env.shell.run('git', ['clone', this.schema.url, projectDir, '--progress'], { stdio: 'inherit' });
    } else {
      const starterTemplate = await this.findStarterTemplate(this.schema.template, this.schema.type, tag);
      await this.downloadStarterTemplate(projectDir, starterTemplate);
    }

    let project: IProject | undefined;

    if (this.project && this.project.details.context === 'multiapp' && !this.schema.cloned) {
      // We're in a multi-app setup, so the new config file isn't wanted.
      await unlink(path.resolve(projectDir, PROJECT_FILE));

      project = await createProjectFromDetails({ context: 'multiapp', configPath: path.resolve(this.project.rootDirectory, PROJECT_FILE), id: projectId, type: this.schema.type, errors: [] }, this.env);
      project.config.set('type', this.schema.type);
      project.config.set('root', path.relative(this.project.rootDirectory, projectDir));
    } else {
      project = await createProjectFromDirectory(projectDir, { _: [] }, this.env, { logErrors: false });
    }

    // start is weird, once the project directory is created, it becomes a
    // "project" command and so we replace the `Project` instance that was
    // autogenerated when the CLI booted up. This has worked thus far?
    this.namespace.root.project = project;

    if (!this.project) {
      throw new FatalException('Error while loading project.');
    }

    this.env.shell.alterPath = p => prependNodeModulesBinToPath(projectDir, p);

    if (!this.schema.cloned) {
      if (this.schema.type === 'react' || this.schema.type === 'vue') {
         options['capacitor'] = true;
      }

      if (this.schema.type === 'angular' && options['cordova'] === null) {
        options['capacitor'] = true;
      }


      if (options['cordova']) {
        const { confirmCordovaUsage } = await import('../lib/integrations/cordova/utils');
        const confirm = await confirmCordovaUsage(this.env);

        if (confirm) {
          await runCommand(runinfo, ['integrations', 'enable', 'cordova', '--quiet']);
        } else {
          options['cordova'] = false;
        }
      }

      if (options['capacitor'] === null && !options['cordova']) {
        const confirm = await this.env.prompt({
          type: 'confirm',
          name: 'confirm',
          message: 'Integrate your new app with Capacitor to target native iOS and Android?',
          default: false,
        });

        if (confirm) {
          options['capacitor'] = true;
        }
      }

      if (options['capacitor']) {
        await runCommand(runinfo, ['integrations', 'enable', 'capacitor', '--quiet', '--', this.schema.name, packageId ? packageId : 'io.ionic.starter']);
      }

      await this.project.personalize({
        name: this.schema.name,
        projectId,
        packageId,
        appIcon: this.schema.appIcon,
        splash: this.schema.splash,
        themeColor: this.schema.themeColor,
      });

      this.env.log.nl();
    }

    const shellOptions: IShellRunOptions = { cwd: projectDir, stdio: 'inherit' };

    if (options['deps']) {
      this.env.log.msg('Installing dependencies may take several minutes.');
      this.env.log.rawmsg(getAdvertisement());

      const [installer, ...installerArgs] = await pkgManagerArgs(this.env.config.get('npmClient'), { command: 'install' });
      await this.env.shell.run(installer, installerArgs, shellOptions);
    } else {
      // --no-deps flag was used so skip installing dependencies, this also results in the package.json being out sync with the package.json so warn the user
      this.env.log.warn('Using the --no-deps flag results in an out of date package lock file. The lock file can be updated by performing an `install` with your package manager.');
    }

    if (!this.schema.cloned) {
      if (gitIntegration) {
        try {
          await this.env.shell.run('git', ['init'], shellOptions); // TODO: use initializeRepo()?
        } catch (e) {
          this.env.log.warn('Error encountered during repo initialization. Disabling further git operations.');
          gitIntegration = false;
        }
      }

      // Prompt to create account
      if (!this.env.session.isLoggedIn()) {
        await promptToSignup(this.env);
      }

      if (options['link']) {
        const cmdArgs = ['link'];

        if (appflowId) {
          cmdArgs.push(appflowId);
        }

        cmdArgs.push('--name', this.schema.name);

        await runCommand(runinfo, cmdArgs);
        linkConfirmed = true;
      }

      const manifestPath = path.resolve(projectDir, 'ionic.starter.json');
      const manifest = await this.loadManifest(manifestPath);

      if (manifest) {
        await unlink(manifestPath);
      }

      if (gitIntegration) {
        try {
          await this.env.shell.run('git', ['add', '-A'], shellOptions);
          await this.env.shell.run('git', ['commit', '-m', 'Initial commit', '--no-gpg-sign'], shellOptions);
        } catch (e) {
          this.env.log.warn('Error encountered during commit. Disabling further git operations.');
          gitIntegration = false;
        }
      }

      if (manifest) {
        await this.performManifestOps(manifest);
      }
    }

    this.env.log.nl();

    await this.showNextSteps(projectDir, this.schema.cloned, linkConfirmed, !options['cordova']);
  }

  async checkForExisting(projectDir: string) {
    const projectExists = await pathExists(projectDir);

    if (projectExists) {
      const confirm = await this.env.prompt({
        type: 'confirm',
        name: 'confirm',
        message: `${input(prettyPath(projectDir))} exists. ${failure('Overwrite?')}`,
        default: false,
      });

      if (!confirm) {
        this.env.log.msg(`Not erasing existing project in ${input(prettyPath(projectDir))}.`);
        throw new FatalException();
      }

      this.canRemoveExisting = confirm;
    }
  }

  async findStarterTemplate(template: string, type: string, tag: string): Promise<ResolvedStarterTemplate> {
    const starterTemplate = STARTER_TEMPLATES.find(t => t.projectType === type && t.name === template);

    if (starterTemplate && starterTemplate.type === 'managed') {
      return {
        ...starterTemplate,
        archive: `${STARTER_BASE_URL}/${tag === 'latest' ? '' : `${tag}/`}${starterTemplate.id}.tar.gz`,
      };
    }

    const tasks = this.createTaskChain();
    tasks.next('Looking up starter');
    const starterList = await getStarterList(this.env.config, tag);

    const starter = starterList.starters.find(t => t.type === type && t.name === template);

    if (starter) {
      tasks.end();

      return {
        name: starter.name,
        projectType: starter.type,
        archive: `${STARTER_BASE_URL}/${tag === 'latest' ? '' : `${tag}/`}${starter.id}.tar.gz`,
      };
    } else {
      throw new FatalException(
        `Unable to find starter template for ${input(template)}\n` +
        `If this is not a typo, please make sure it is a valid starter template within the starters repo: ${strong('https://github.com/ionic-team/starters')}`
      );
    }
  }

  async validateProjectType(type: string) {
    const projectTypes = getStarterProjectTypes();

    if (!['custom', ...projectTypes].includes(type)) {
      throw new FatalException(
        `${input(type)} is not a valid project type.\n` +
        `Please choose a different ${input('--type')}. Use ${input('ionic start --list')} to list all available starter templates.`
      );
    }
  }

  async validateProjectId(projectId: string) {
    if (!isValidProjectId(projectId)) {
      throw new FatalException(
        `${input(projectId)} is not a valid package or directory name.\n` +
        `Please choose a different ${input('--project-id')}. Alphanumeric characters are always safe.`
      );
    }
  }

  async loadManifest(manifestPath: string): Promise<StarterManifest | undefined> {
    try {
      return await readStarterManifest(manifestPath);
    } catch (e) {
      debug(`Error with manifest file ${strong(prettyPath(manifestPath))}: ${e}`);
    }
  }

  async performManifestOps(manifest: StarterManifest) {
    if (manifest.welcome) {
      this.env.log.nl();
      this.env.log.msg(`${strong('Starter Welcome')}:`);
      this.env.log.msg(manifest.welcome);
    }
  }

  async downloadStarterTemplate(projectDir: string, starterTemplate: ResolvedStarterTemplate) {
    const { createRequest, download } = await import('../lib/utils/http');
    const { tar } = await import('../lib/utils/archive');

    const tasks = this.createTaskChain();
    const task = tasks.next(`Downloading and extracting ${input(starterTemplate.name.toString())} starter`);
    debug('Tar extraction created for %s', projectDir);
    const ws = tar.extract({ cwd: projectDir });

    const { req } = await createRequest('GET', starterTemplate.archive, this.env.config.getHTTPConfig());
    await download(req, ws, { progress: (loaded, total) => task.progress(loaded, total) });

    tasks.end();
  }

  async showNextSteps(projectDir: string, cloned: boolean, linkConfirmed: boolean, isCapacitor: boolean) {
    const cordovaResCommand = isCapacitor ? 'cordova-res --skip-config --copy' : 'cordova-res';
    const steps = [
      `Go to your ${cloned ? 'cloned' : 'new'} project: ${input(`cd ${prettyPath(projectDir)}`)}`,
      `Run ${input('ionic serve')} within the app directory to see your app in the browser`,
      isCapacitor ?
        `Run ${input('ionic capacitor add')} to add a native iOS or Android project using Capacitor` :
        `Run ${input('ionic cordova platform add')} to add a native iOS or Android project using Cordova`,
      `Generate your app icon and splash screens using ${input(cordovaResCommand)}`,
      `Explore the Ionic docs for components, tutorials, and more: ${strong('https://ion.link/docs')}`,
      `Building an enterprise app? Ionic has Enterprise Support and Features: ${strong('https://ion.link/enterprise-edition')}`,
    ];

    if (linkConfirmed) {
      steps.push(`Push your code to Ionic Appflow to perform real-time updates, and more: ${input('git push ionic master')}`);
    }

    this.env.log.msg(`${strong('Your Ionic app is ready! Follow these next steps')}:\n${steps.map(s => ` - ${s}`).join('\n')}`);
  }
}
