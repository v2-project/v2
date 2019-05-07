# V2: Fast Detection of Configuration Drift in Python

V2 detects and repairs instances of configuration drift in Python snippets.

## Dependencies

| Name           | Version |
| -------------- | ------- |
| Node.js        | 12.1.0  |
| Docker         | 18.09.2 |
| Docker Compose | 1.23.2  |

## Setup

Install dependencies and link the V2 executable with 

```
npm i
npm link
```

Then build Docker images and start services

```
v2 build
docker-compose up --detach
```

V2 requires the Docker daemon to be up and running. Additionally, the user
must have permissions to create Docker containers.

## Running V2

To run V2 on a code snippet with logging information, run

```
v2 run --verbose <code-snippet>
```

V2 will attempt to create a Dockerfile describing a working environment
configuration. If one cannot be found, it will present information about
what instances of configuration drift were found and patched.

V2 may also be run from inside a Docker, but requires having the Docker socket
bind mounted.

```
docker run --rm -it --mount type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock -v "$(pwd):/data:ro" --network=<network> localhost:5000/v2/v2:latest v2 run /data
``` 

## Examples

All examples are stored under `examples/`.

### Bayes

```
v2 run examples/bayes/bayes.py
```

Running on Bayes will produce the following Dockerfile.

```dockerfile
FROM python:3.7
COPY . /app
RUN ["apt-get","update"]
RUN ["pip","install","the==0.1.5"]
RUN ["pip","install","PyYAML==5.1"]
RUN ["pip","install","numpy==1.16.3"]
RUN ["pip","install","scipy==1.2.1"]
RUN ["pip","install","Theano==0.8.2"]
RUN ["pip","install","Lasagne==0.1"]
CMD ["python","/app/bayes.py"]
```

### Guess Candidate Model

```
v2 run examples/guess_candidate_model/guess_candidate_model.py
```

No working environment can be found for Guess Candidate Model due to an error
in the gist. However, two instances of configuration drift are still found.


```json
{
    "name": "NoWorkingEnvironmentFoundError",
    "time": 271,
    "validations": 12,
    "metadata": [
        {
            "id": "0",
            "fixedValidations": [
                {
                    "status_code": "Failed",
                    "dependencies": {
                        "status_code": "Success",
                        "install_errors": []
                    },
                    "execution": {
                        "status_code": "Exception",
                        "exception_name": "ModuleNotFoundError",
                        "exception_message": "No module named 'sklearn.cross_validation'",
                        "exception_file_name": "/data/examples/guess_candidate_model/guess_candidate_model.py",
                        "exception_line_number": 4,
                        "exception_line": "from sklearn.cross_validation import train_test_split",
                        "exception_stack": [
                            [
                                "/data/examples/guess_candidate_model/guess_candidate_model.py",
                                4,
                                "<module>",
                                "from sklearn.cross_validation import train_test_split"
                            ]
                        ]
                    },
                    "validations": 1
                },
                {
                    "status_code": "Failed",
                    "dependencies": {
                        "status_code": "Success",
                        "install_errors": []
                    },
                    "execution": {
                        "status_code": "Exception",
                        "exception_name": "ModuleNotFoundError",
                        "exception_message": "No module named 'tensorflow'",
                        "exception_file_name": "/usr/local/lib/python3.7/site-packages/keras/backend/tensorflow_backend.py",
                        "exception_line_number": 5,
                        "exception_line": "import tensorflow as tf",
                        "exception_stack": [
                            [
                                "/data/examples/guess_candidate_model/guess_candidate_model.py",
                                5,
                                "<module>",
                                "from keras.preprocessing import sequence, text"
                            ],
                            [
                                "/usr/local/lib/python3.7/site-packages/keras/__init__.py",
                                3,
                                "<module>",
                                "from . import utils"
                            ],
                            [
                                "/usr/local/lib/python3.7/site-packages/keras/utils/__init__.py",
                                6,
                                "<module>",
                                "from . import conv_utils"
                            ],
                            [
                                "/usr/local/lib/python3.7/site-packages/keras/utils/conv_utils.py",
                                9,
                                "<module>",
                                "from .. import backend as K"
                            ],
                            [
                                "/usr/local/lib/python3.7/site-packages/keras/backend/__init__.py",
                                89,
                                "<module>",
                                "from .tensorflow_backend import *"
                            ],
                            [
                                "/usr/local/lib/python3.7/site-packages/keras/backend/tensorflow_backend.py",
                                5,
                                "<module>",
                                "import tensorflow as tf"
                            ]
                        ]
                    },
                    "validations": 4
                }
            ],
            "mutations": [
                {
                    "type": "decrement_semver_minor",
                    "changes": {
                        "package": "scikit-learn",
                        "from": "0.20.3",
                        "to": "0.19.2"
                    },
                    "iddfs": {
                        "mutatorIndex": 1
                    }
                },
                {
                    "type": "decrement_semver_major",
                    "changes": {
                        "package": "Keras",
                        "from": "2.2.4",
                        "to": "1.2.2"
                    },
                    "iddfs": {
                        "index": 1,
                        "mutatorIndex": 0
                    }
                },
                {
                    "type": "decrement_semver_major",
                    "changes": {
                        "package": "Keras",
                        "from": "1.2.2",
                        "to": "0.3.3"
                    },
                    "iddfs": {
                        "index": 1,
                        "mutatorIndex": 0
                    }
                }
            ],
            "checkpoint": {
                "status_code": "Failed",
                "dependencies": {
                    "status_code": "Success",
                    "install_errors": []
                },
                "execution": {
                    "status_code": "Exception",
                    "exception_name": "NameError",
                    "exception_message": "name 'labeled_sample' is not defined",
                    "exception_file_name": "/data/examples/guess_candidate_model/guess_candidate_model.py",
                    "exception_line_number": 27,
                    "exception_line": "X = [x[1] for x in labeled_sample]",
                    "exception_stack": [
                        [
                            "/data/examples/guess_candidate_model/guess_candidate_model.py",
                            27,
                            "<module>",
                            "X = [x[1] for x in labeled_sample]"
                        ]
                    ]
                },
                "validations": 0
            },
            "code": "NotRepairable",
            "message": "Validation exception 'NameError' is not repairable."
        },
        ...
    ],
    "message": "Unable to find a working environment configuration",
    "stack": [
        "NoWorkingEnvironmentFoundError: Unable to find a working environment configuration",
        "    at V2.infer (/v2/index.js:359:15)",
        "    at process._tickCallback (internal/process/next_tick.js:68:7)"
    ]
}
```

### Mobi

```
v2 run examples/mobi/mobi.py
```

Running on Mobi will produce the following Dockerfile.

```dockerfile
FROM python:2.7
COPY . /app
RUN ["apt-get","update"]
RUN ["pip","install","six==1.12.0"]
RUN ["pip","install","docutils==0.14"]
RUN ["pip","install","pydocumentdb==2.3.3"]
RUN ["pip","install","Sphinx==1.4.5"]
CMD ["python","/app/mobi.py"]
```
