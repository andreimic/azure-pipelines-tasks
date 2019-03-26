"use strict";

import * as tl from "vsts-task-lib/task";
import * as fs from 'fs';
import ContainerConnection from "docker-common/containerconnection";
import * as dockerCommandUtils from "docker-common/dockercommandutils";
import * as utils from "./utils";
import { findDockerFile } from "docker-common/fileutils";
import { getBaseImageName, getResourceName } from "docker-common/containerimageutils";
import { WebRequest, WebResponse, sendRequest } from 'utility-common/restutilities';
import Q = require('q');

function pushMultipleImages(connection: ContainerConnection, imageNames: string[], tags: string[], commandArguments: string, onCommandOut: (image, output) => any): any {
    let promise: Q.Promise<void>;
    // create chained promise of push commands
    if (imageNames && imageNames.length > 0) {
        imageNames.forEach(imageName => {
            if (tags && tags.length > 0) {
                tags.forEach(tag => {
                    let imageNameWithTag = imageName + ":" + tag;
                    if (promise) {
                        promise = promise.then(() => {
                            return dockerCommandUtils.push(connection, imageNameWithTag, commandArguments, onCommandOut)
                        });
                    }
                    else {
                        promise = dockerCommandUtils.push(connection, imageNameWithTag, commandArguments, onCommandOut);
                    }
                });
            }
            else {
                if (promise) {
                    promise = promise.then(() => {
                        return dockerCommandUtils.push(connection, imageName, commandArguments, onCommandOut)
                    });
                }
                else {
                    promise = dockerCommandUtils.push(connection, imageName, commandArguments, onCommandOut);
                }
            }
        });
    }

    // will return undefined promise in case imageNames is null or empty list
    return promise;
}

export function run(connection: ContainerConnection, outputUpdate: (data: string) => any): any {
    var commandArguments = tl.getInput("arguments", false);

    // get tags input
    let tags = tl.getDelimitedInput("tags", "\n");

    // get qualified image name from the containerRegistry input
    let repositoryName = tl.getInput("repository");
    let imageNames: string[] = [];
    // if container registry is provided, use that
    // else, use the currently logged in registries
    if (tl.getInput("containerRegistry")) {
        let imageName = connection.getQualifiedImageName(repositoryName);
        if (imageName) {
            imageNames.push(imageName);
        }
    }
    else {
        imageNames = connection.getQualifiedImageNamesFromConfig(repositoryName);
    }

    const dockerfilepath = tl.getInput("dockerFile", true);
    const dockerFile = findDockerFile(dockerfilepath);
    if (!tl.exist(dockerFile)) {
        throw new Error(tl.loc('ContainerDockerFileNotFound', dockerfilepath));
    }

    // push all tags
    let output = "";
    let outputImageName = "";
    let digest = "";
    let promise = pushMultipleImages(connection, imageNames, tags, commandArguments, (image, commandOutput) => {
        output += commandOutput;
        outputImageName = image;
        digest = extractDigestFromOutput(commandOutput);
    });

    if (promise) {
        promise = promise.then(() => {
            publishToImageMetadataStore(connection, outputImageName, tags, digest, dockerFile).then((result)=>{
                console.log(tl.loc("ImageDetailsApiResponse", result));
            });

            let taskOutputPath = utils.writeTaskOutput("push", output);
            outputUpdate(taskOutputPath);
        });
    }
    else {
        tl.debug(tl.loc('NotPushingAsNoLoginFound'));
        promise = Q.resolve(null);
    }

    return promise;
}

async function publishToImageMetadataStore(connection: ContainerConnection, imageName: string, tags: string[], digest: string, dockerFilePath: string): Promise<any> {
    const imageUri: string = getResourceName(imageName, digest);
    const dockerFileContent: string = fs.readFileSync(dockerFilePath, 'utf-8').toString();
    const baseImageName = getBaseImageName(dockerFileContent);
    const layers = dockerCommandUtils.getLayers(connection, imageUri);
    const buildId = parseInt(tl.getVariable("Build.BuildId"));
    const buildDefinitionName = tl.getVariable("Build.DefinitionName");
    const buildVersion = tl.getVariable("Build.BuildNumber");
    const buildDefinitionId = tl.getVariable("System.DefinitionId");

    const requestUrl: string = tl.getVariable("System.TeamFoundationCollectionUri") + "/" + tl.getVariable("System.TeamProject") + "/_apis/deployment/imagedetails?api-version=5.0-preview.1";
    const requestBody: string = JSON.stringify(
        {
            "imageName": imageUri,
            "imageUri": imageUri,
            "hash": digest,
            "baseImageName": baseImageName,
            "distance": 0,
            "imageType": "",
            "mediaType": "",
            "tags": tags,
            "layerInfo": layers,
            "buildId": buildId,
            "buildVersion": buildVersion,
            "buildDefinitionName": buildDefinitionName,
            "buildDefinitionId": buildDefinitionId
        }
    );

    const request = new WebRequest();
    request.uri = requestUrl;
    request.method = 'POST';
    request.body = requestBody;
    request.headers = { "Content-Type": "application/json" };

    try {
        const response = await sendRequest(request);
        return response;
    } catch (error) {
        tl.debug('Unable to push to Image Details Artifact Store, Error: ' + error);
    }

    return Promise.resolve();
}

function extractDigestFromOutput(output: string): string {
    const matchPatternForDigest = new RegExp(/sha256\:([\w]+)/);
    const imageMatch = output.match(matchPatternForDigest);
    if (imageMatch && imageMatch.length >= 1) {
        return imageMatch[1];
    }

    return "";
}
