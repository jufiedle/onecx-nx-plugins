import {
  formatFiles,
  generateFiles,
  GeneratorCallback,
  installPackagesTask,
  joinPathFragments,
  names,
  readJson,
  Tree,
  updateJson,
} from '@nx/devkit';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as ora from 'ora';
import { deepMerge } from '../shared/deepMerge';
import { renderJsonFile } from '../shared/renderJsonFile';
import { CreateGeneratorSchema, DetailsGeneratorSchema } from './schema';
import path = require('path');
import processParams, { GeneratorParameter } from '../shared/parameters.util';

const PARAMETERS: GeneratorParameter<DetailsGeneratorSchema>[] = [
  {
    key: 'customizeNamingForAPI',
    type: 'boolean',
    required: 'interactive',
    default: false,
    prompt: 'Do you want to customize the names for the generated API?',
  },
  {
    key: 'apiServiceName',
    type: 'text',
    required: 'interactive',
    default: (values) => {
      return `${names(values.featureName).className}BffService`;
    },
    prompt: 'Provide a name for your API service (e.g., BookService): ',
    showInSummary: true,
    showRules: [{ showIf: (values) => values.customizeNamingForAPI }],
  },
  {
    key: 'dataObjectName',
    type: 'text',
    required: 'interactive',
    default: (values) => {
      return `${names(values.featureName).className}`;
    },
    prompt: 'Provide a name for your Data Object (e.g., Book): ',
    showInSummary: true,
    showRules: [{ showIf: (values) => values.customizeNamingForAPI }],
  },
  {
    key: 'getByIdResponseName',
    type: 'text',
    required: 'interactive',
    default: (values) => {
      return `Get${names(values.featureName).className}ByIdResponse`;
    },
    prompt:
      'Provide a name for your GetByIdResponse (e.g., GetBookByIdResponse): ',
    showInSummary: true,
    showRules: [{ showIf: (values) => values.customizeNamingForAPI }],
  },
];

export async function createGenerator(
  tree: Tree,
  options: CreateGeneratorSchema
): Promise<GeneratorCallback> {
  const parameters = await processParams(PARAMETERS, options);
  Object.assign(options, parameters);

  const spinner = ora(`Adding create dialog to ${options.featureName}`).start();
  const directory = '.';

  const isNgRx = !!Object.keys(
    readJson(tree, 'package.json').dependencies
  ).find((k) => k.includes('@ngrx/'));
  if (!isNgRx) {
    spinner.fail('Currently only NgRx projects are supported.');
    throw new Error('Currently only NgRx projects are supported.');
  }

  generateFiles(
    tree,
    joinPathFragments(__dirname, './files/ngrx'),
    `${directory}/`,
    {
      ...options,
      featureFileName: names(options.featureName).fileName,
      featurePropertyName: names(options.featureName).propertyName,
      featureClassName: names(options.featureName).className,
      featureConstantName: names(options.featureName).constantName,
    }
  );

  adaptFeatureModule(tree, options);

  adaptFeatureRoutes(tree, options);

  adaptFeatureState(tree, options);

  adaptFeatureReducer(tree, options);

  addTranslations(tree, options);

  addFunctionToOpenApi(tree, options);

  addDetailsEventsToSearch(tree, options);

  await formatFiles(tree);
  return () => {
    installPackagesTask(tree);
    execSync('npm run apigen', {
      cwd: tree.root,
      stdio: 'inherit',
    });
    const files = tree
      .listChanges()
      .map((c) => c.path)
      .filter((p) => p.endsWith('.ts'))
      .join(' ');
    execSync('npx organize-imports-cli ' + files, {
      cwd: tree.root,
      stdio: 'inherit',
    });
    execSync('npx prettier --write ' + files, {
      cwd: tree.root,
      stdio: 'inherit',
    });
  };
}

function addFunctionToOpenApi(tree: Tree, options: DetailsGeneratorSchema) {
  const openApiFolderPath = 'src/assets/swagger';
  const openApiFiles = tree.children(openApiFolderPath);
  const bffOpenApiPath = openApiFiles.find((f) => f.endsWith('-bff.yaml'));
  let bffOpenApiContent = tree.read(
    joinPathFragments(openApiFolderPath, bffOpenApiPath),
    'utf8'
  );

  const dataObjectName = options.dataObjectName;
  const propertyName = names(options.featureName).propertyName;
  const apiServiceName = options.apiServiceName;
  const dataObjectResponseName = options.getByIdResponseName;
  const hasSchemas = bffOpenApiContent.includes('schemas:');
  const hasEntitySchema =
    hasSchemas && bffOpenApiContent.includes(`${dataObjectName}:`);
  const hasProblemDetailSchema =
    hasSchemas && bffOpenApiContent.includes('ProblemDetailResponse:');

  //TODO: schema for error cases
  bffOpenApiContent = bffOpenApiContent.replace(`paths: {}`, `paths:`).replace(
    `paths:`,
    `
  paths:
    /${propertyName}:
      post:
        x-onecx:
          permissions:
            ${propertyName}:
              - create
        operationId: create${dataObjectName}
        tags:
          - ${apiServiceName}
        requestBody:
            required: true
            content:
            application/json:
                schema:
                $ref: "#/components/schemas/Create${dataObjectName}"
        responses:
          201:
            description: New ${dataObjectName} created
            headers:
                Location:
                required: true
                schema:
                    type: string
                    format: url
            content:
              application/json:
                schema:
                  $ref: '#/components/schemas/${dataObjectResponseName}'
          400:
            description: Bad request
            content:
              application/json:
                schema:
                  $ref: '#/components/schemas/ProblemDetailResponse'    
  `
  );

  const propertyUpdateSchema = `
    /${propertyName}/{id}:
      put:
        x-onecx:
          permissions:
            ${propertyName}:
              - read
        operationId: update${dataObjectName}
        tags:
          - ${apiServiceName}
        parameters:
          - name: 'id'
            in: 'path'
            required: true
            schema:
                type: 'string'
        requestBody:
            required: true
            content:
            application/json:
                schema:
                $ref: "#/components/schemas/Create${dataObjectName}"
        responses:
          204:
            description: ${dataObjectName} updated
            content:
              application/json:
                schema:
                  $ref: '#/components/schemas/${dataObjectResponseName}'
          400:
            description: Bad request
            content:
              application/json:
                schema:
                  $ref: '#/components/schemas/ProblemDetailResponse'
          404:
            description: 'Not Found'`;

  bffOpenApiContent = bffOpenApiContent
    .replace(`paths: {}`, `paths:`)
    .replace(`/${propertyName}/{id}:`, propertyUpdateSchema);

  if (!hasSchemas) {
    bffOpenApiContent += `
  components:
    schemas:`;
  }

  let entitySchema = `
      ${dataObjectName}:
        type: object
        required:
          - "modificationCount"
          - "id"
        properties:
          modificationCount:
            type: integer
            format: int32
          id:
            type: integer
            format: int64
          # ACTION: add additional properties here`;

  if (hasEntitySchema) {
    entitySchema = '';
  }

  const problemDetailResponseSchema = `
      ProblemDetailResponse:
        type: object
        properties:
          errorCode:
            type: string
          detail:
            type: string
          params:
            type: array
            items:
              $ref: '#/components/schemas/ProblemDetailParam'
          invalidParams:
            type: array
            items:
              $ref: '#/components/schemas/ProblemDetailInvalidParam'
            
      ProblemDetailParam:
        type: object
        properties:
          key:
            type: string
          value:
            type: string
            
      ProblemDetailInvalidParam:
        type: object
        properties:
          name:
            type: string
          message:
            type: string`;
  const  dataObjectResponseName

  bffOpenApiContent = bffOpenApiContent.replace(
    `
    schemas:`,
    `
    schemas:
      ${entitySchema}
  
      ${dataObjectResponseName}:
        type: object
        required:
          - "result"
        properties:
          result:
            $ref: '#/components/schemas/${dataObjectName}'
  
      ${hasProblemDetailSchema ? '' : problemDetailResponseSchema}
  `
  );

  tree.write(
    joinPathFragments(openApiFolderPath, bffOpenApiPath),
    bffOpenApiContent
  );
}

function adaptFeatureModule(tree: Tree, options: DetailsGeneratorSchema) {
  const fileName = names(options.featureName).fileName;
  const className = names(options.featureName).className;
  const moduleFilePath = `src/app/${fileName}/${fileName}.module.ts`;
  let moduleContent = tree.read(moduleFilePath, 'utf8');
  moduleContent = moduleContent.replace(
    'declarations: [',
    `declarations: [${className}DetailsComponent,`
  );
  moduleContent = moduleContent.replace(
    `} from '@onecx/portal-integration-angular'`,
    `InitializeModuleGuard, } from '@onecx/portal-integration-angular'`
  );
  moduleContent = moduleContent.replace(
    'EffectsModule.forFeature()',
    `EffectsModule.forFeature([])`
  );
  moduleContent = moduleContent.replace(
    'EffectsModule.forFeature([',
    `EffectsModule.forFeature([${className}DetailsEffects,`
  );
  moduleContent = moduleContent.replace(
    `from '@ngrx/effects';`,
    `from '@ngrx/effects';
    import { ${className}DetailsEffects } from './pages/${fileName}-details/${fileName}-details.effects';
    import { ${className}DetailsComponent } from './pages/${fileName}-details/${fileName}-details.component';`
  );

  tree.write(moduleFilePath, moduleContent);
}

function adaptFeatureRoutes(tree: Tree, options: DetailsGeneratorSchema) {
  const fileName = names(options.featureName).fileName;
  const className = names(options.featureName).className;
  const routesFilePath = `src/app/${fileName}/${fileName}.routes.ts`;
  let moduleContent = tree.read(routesFilePath, 'utf8');
  moduleContent = moduleContent.replace(
    'routes: Routes = [',
    `routes: Routes = [ { path: 'details/:id', component: ${className}DetailsComponent, pathMatch: 'full' },`
  );

  moduleContent =
    `import { ${className}DetailsComponent } from './pages/${fileName}-details/${fileName}-details.component';` +
    moduleContent;
  tree.write(routesFilePath, moduleContent);
}

function adaptFeatureState(tree: Tree, options: DetailsGeneratorSchema) {
  const fileName = names(options.featureName).fileName;
  const className = names(options.featureName).className;
  const filePath = `src/app/${fileName}/${fileName}.state.ts`;

  let fileContent = tree.read(filePath, 'utf8');
  fileContent = fileContent.replace(
    'State {',
    `State {
      details: ${className}DetailsState;
    `
  );

  fileContent =
    `import { ${className}DetailsState } from './pages/${fileName}-details/${fileName}-details.state';` +
    fileContent;
  tree.write(filePath, fileContent);
}

function adaptFeatureReducer(tree: Tree, options: DetailsGeneratorSchema) {
  const fileName = names(options.featureName).fileName;
  const propertyName = names(options.featureName).propertyName;
  const filePath = `src/app/${fileName}/${fileName}.reducers.ts`;

  let fileContent = tree.read(filePath, 'utf8');

  fileContent = fileContent.replace(
    '>({',
    `>({
      details: ${propertyName}DetailsReducer,`
  );

  fileContent =
    `import { ${propertyName}DetailsReducer } from './pages/${fileName}-details/${fileName}-details.reducers';` +
    fileContent;
  tree.write(filePath, fileContent);
}

function addTranslations(tree: Tree, options: DetailsGeneratorSchema) {
  const folderPath = 'src/assets/i18n/';
  const masterJsonPath = path.resolve(
    __dirname,
    './input-files/i18n/master.json.template'
  );

  const masterJsonContent = renderJsonFile(masterJsonPath, {
    ...options,
    featureConstantName: names(options.featureName).constantName,
    featureClassName: names(options.featureName).className,
  });

  tree.children(folderPath).forEach((file) => {
    updateJson(tree, joinPathFragments(folderPath, file), (json) => {
      const jsonPath = joinPathFragments(
        path.resolve(__dirname, './input-files/i18n/'),
        file + '.template'
      );
      let jsonContent = {};
      if (fs.existsSync(jsonPath)) {
        jsonContent = renderJsonFile(jsonPath, {
          ...options,
          featureConstantName: names(options.featureName).constantName,
          featureClassName: names(options.featureName).className,
        });
      }

      json = deepMerge(masterJsonContent, jsonContent, json);

      return json;
    });
  });
}

function addDetailsEventsToSearch(tree: Tree, options: DetailsGeneratorSchema) {
  const fileName = names(options.featureName).fileName;
  const htmlSearchFilePath = `src/app/${fileName}/pages/${fileName}-search/${fileName}-search.component.html`;

  if (tree.exists(htmlSearchFilePath)) {
    adaptSearchHTML(tree, options);
    adaptSearchComponent(tree, options);
    adaptSearchActions(tree, options);
    adaptSearchEffects(tree, options);
  }
}

function adaptSearchHTML(tree: Tree, options: DetailsGeneratorSchema) {
  const fileName = names(options.featureName).fileName;
  const htmlSearchFilePath = `src/app/${fileName}/pages/${fileName}-search/${fileName}-search.component.html`;

  let htmlContent = tree.read(htmlSearchFilePath, 'utf8');
  if (!htmlContent.includes('(viewItem)="details($event)")')) {
    htmlContent = htmlContent.replace(
      '<ocx-interactive-data-view',
      `<ocx-interactive-data-view \n (viewItem)="details($event)"`
    );
    tree.write(htmlSearchFilePath, htmlContent);
  }
}

function adaptSearchComponent(tree: Tree, options: DetailsGeneratorSchema) {
  const fileName = names(options.featureName).fileName;
  const className = names(options.featureName).className;
  const filePath = `src/app/${fileName}/pages/${fileName}-search/${fileName}-search.component.ts`;

  let htmlContent = tree.read(filePath, 'utf8');
  htmlContent =
    `import {RowListGridData} from '@onecx/portal-integration-angular';` +
    htmlContent.replace(
      'resetSearch',
      `
      details({id}:RowListGridData) {
        this.store.dispatch(${className}SearchActions.detailsButtonClicked({id}));
      }
  
      resetSearch`
    );
  tree.write(filePath, htmlContent);
}

function adaptSearchActions(tree: Tree, options: DetailsGeneratorSchema) {
  const fileName = names(options.featureName).fileName;
  const filePath = `src/app/${fileName}/pages/${fileName}-search/${fileName}-search.actions.ts`;

  let htmlContent = tree.read(filePath, 'utf8');
  htmlContent = htmlContent.replace(
    'events: {',
    `events: {
        'Details button clicked': props<{
          id: number | string;
        }>(),
      `
  );
  tree.write(filePath, htmlContent);
}

function adaptSearchEffects(tree: Tree, options: DetailsGeneratorSchema) {
  const fileName = names(options.featureName).fileName;
  const className = names(options.featureName).className;
  const filePath = `src/app/${fileName}/pages/${fileName}-search/${fileName}-search.effects.ts`;

  let htmlContent = tree.read(filePath, 'utf8');
  htmlContent =
    `import { selectUrl } from 'src/app/shared/selectors/router.selectors';` +
    htmlContent.replace(
      'searchByUrl$',
      `detailsButtonClicked$ = createEffect(
        () => {
          return this.actions$.pipe(
            ofType(${className}SearchActions.detailsButtonClicked),
            concatLatestFrom(() => this.store.select(selectUrl)),
            tap(([action, currentUrl]) => {
              let urlTree = this.router.parseUrl(currentUrl);
              urlTree.queryParams = {};
              urlTree.fragment = null;
              this.router.navigate([urlTree.toString(), 'details', action.id]);
          })
        )},
        { dispatch: false }
      );
      
      searchByUrl$`
    );
  tree.write(filePath, htmlContent);
}

export default createGenerator;
